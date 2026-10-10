import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '/vendor/simplewebauthn/index.js';

const ROLES = [
  ['manager', '管理者'],
  ['member', '参加者'],
];
const ERRORS = {
  verification_failed: 'Passkeyの検証に失敗しました',
  credential_already_registered: 'このPasskeyは登録済みです',
  last_passkey: '最後のPasskeyは削除できません',
  last_manager: '最後の管理者は退出できません',
  invitation_invalid: '招待が無効か期限切れです',
  already_member: '既にこの案件に参加しています',
  sole_manager_of_shared_project: '他の参加者がいる案件の唯一の管理者です。他の参加者を解除するまで削除できません',
  forbidden: '権限がありません',
  not_found: '見つかりません',
  invalid_request: '入力内容が正しくありません',
  unauthenticated: 'ログインしてください',
  csrf: 'ページを再読み込みしてください',
};
const INVITE_KEY = 'myid.pendingInvite';
const label = (list, value) => list.find(([v]) => v === value)?.[1] ?? value;

let csrf = null;
let authenticated = false;

// ---- DOM ----

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '');

function notify(text, isError = false) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.className = isError ? 'error' : '';
  el.hidden = !text;
}

// ---- API ----

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function api(method, path, body, retried = false) {
  const headers = {};
  if (method !== 'GET') {
    headers['x-csrf-token'] = csrf ?? '';
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (data?.csrfToken) csrf = data.csrfToken;
  if (res.ok) return data;
  const code = data?.error ?? 'error';
  // 重要操作で再認証を求められたら、Passkeyで再認証してから1回だけ再試行する
  if (code === 'reauthentication_required' && !retried) {
    await reauthenticate();
    return api(method, path, body, true);
  }
  if (code === 'unauthenticated') {
    authenticated = false;
    route();
  }
  throw new ApiError(res.status, code);
}

async function run(fn, success) {
  try {
    notify('');
    await fn();
    if (success) notify(success);
  } catch (err) {
    if (err?.name === 'NotAllowedError') notify('Passkeyの操作がキャンセルされました', true);
    else if (err?.name === 'InvalidStateError') notify('この認証器には既にこのアカウントのPasskeyがあります', true);
    else notify(ERRORS[err?.code] ?? `エラー: ${err?.code ?? err?.message ?? err}`, true);
  }
}

async function refreshSession() {
  const s = await api('GET', '/session');
  authenticated = s.authenticated;
}

// ---- 認証 ----

async function register(accountLabel) {
  const optionsJSON = await api('POST', '/auth/register/options');
  // 識別名はOS・ブラウザのPasskey選択画面で区別するためだけに使い、サーバーへは送らない
  const name = accountLabel.trim() || `myid ${new Date().toISOString().slice(0, 10)}`;
  optionsJSON.user.name = name;
  optionsJSON.user.displayName = name;
  const response = await startRegistration({ optionsJSON });
  await api('POST', '/auth/register/verify', { response });
  authenticated = true;
}

async function login() {
  const optionsJSON = await api('POST', '/auth/login/options');
  const response = await startAuthentication({ optionsJSON });
  await api('POST', '/auth/login/verify', { response });
  authenticated = true;
}

async function reauthenticate() {
  notify('重要な操作のためPasskeyで再認証してください');
  const optionsJSON = await api('POST', '/auth/reauth/options');
  const response = await startAuthentication({ optionsJSON });
  await api('POST', '/auth/reauth/verify', { response });
  notify('');
}

async function afterLogin() {
  const token = sessionStorage.getItem(INVITE_KEY);
  location.hash = token ? '#/invite' : '#/projects';
  await route();
}

// ---- 画面 ----

const main = () => document.getElementById('main');

function renderLogin() {
  const pending = sessionStorage.getItem(INVITE_KEY);
  const regForm = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        run(async () => {
          await register(new FormData(e.target).get('label') ?? '');
          await afterLogin();
        });
      },
    },
    h('input', { name: 'label', placeholder: '識別名（端末内のみ・任意）', maxlength: 64, autocomplete: 'off' }),
    h('button', { class: 'primary' }, '新規アカウント作成'),
  );
  main().replaceChildren(
    pending ? h('p', {}, '招待を受けるにはログインまたはアカウント作成をしてください') : null,
    h('section', {}, h('h2', {}, 'ログイン'), h('button', { class: 'primary', onclick: () => run(async () => { await login(); await afterLogin(); }) }, 'Passkeyでログイン')),
    h(
      'section',
      {},
      h('h2', {}, '新規アカウント'),
      h('p', { class: 'muted' }, 'メールアドレス・電話番号・氏名は不要です。同じ端末で複数のアカウントを作成でき、ログイン時に選択します。'),
      regForm,
    ),
    browserSupportsWebAuthn() ? null : h('p', { class: 'error' }, 'このブラウザはPasskeyに対応していません'),
  );
}

function renderInvite() {
  const token = sessionStorage.getItem(INVITE_KEY);
  if (!token) {
    location.hash = '#/projects';
    return;
  }
  main().replaceChildren(
    h(
      'section',
      {},
      h('h2', {}, '案件への招待'),
      h('p', {}, '現在のアカウントで招待を受諾します。別のアカウントで参加する場合は、ログアウトしてから受諾してください。'),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            onclick: () =>
              run(async () => {
                const res = await api('POST', '/invitations/accept', { token });
                sessionStorage.removeItem(INVITE_KEY);
                notify('案件に参加しました');
                location.hash = `#/p/${res.projectId}`;
              }),
          },
          '受諾',
        ),
        h('button', { onclick: () => { sessionStorage.removeItem(INVITE_KEY); location.hash = '#/projects'; } }, '破棄'),
      ),
    ),
  );
}

async function renderProjects() {
  const data = await api('GET', '/projects');
  const rows = data.projects.map((p) =>
    h('tr', {}, h('td', {}, h('a', { href: `#/p/${p.id}` }, p.name)), h('td', {}, label(ROLES, p.role)), h('td', {}, fmt(p.createdAt))),
  );
  main().replaceChildren(
    h('h2', {}, '案件'),
    h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const name = new FormData(e.target).get('name');
          run(async () => {
            const { id } = await api('POST', '/projects', { name });
            location.hash = `#/p/${id}`;
          });
        },
      },
      h('input', { name: 'name', required: true, maxlength: 100, placeholder: '案件名' }),
      h('button', { class: 'primary' }, '作成'),
    ),
    rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '案件名'), h('th', {}, '立場'), h('th', {}, '作成日時'))), h('tbody', {}, rows))
      : h('p', { class: 'muted' }, '参加している案件はありません'),
  );
}

async function renderProject(id) {
  const [project, { members }] = await Promise.all([api('GET', `/projects/${id}`), api('GET', `/projects/${id}/members`)]);
  const can = (action) => project.access.actions.includes(action);
  const reload = () => renderProject(id);
  const parts = [h('h2', {}, project.name), h('p', { class: 'muted' }, `立場: ${label(ROLES, project.access.role)} / 作成: ${fmt(project.createdAt)}`)];

  if (can('project.rename')) {
    parts.push(
      h(
        'form',
        {
          onsubmit: (e) => {
            e.preventDefault();
            const name = new FormData(e.target).get('name');
            run(async () => { await api('PATCH', `/projects/${id}`, { name }); await reload(); }, '案件名を変更しました');
          },
        },
        h('input', { name: 'name', value: project.name, required: true, maxlength: 100 }),
        h('button', {}, '案件名を変更'),
      ),
    );
  }

  const memberRows = members.map((m) =>
    h(
      'tr',
      {},
      h('td', { class: 'mono' }, m.id.slice(0, 8), m.isSelf ? h('span', { class: 'muted' }, '（自分）') : null),
      h('td', {}, label(ROLES, m.role)),
      h('td', {}, fmt(m.joinedAt)),
      h(
        'td',
        {},
        m.isSelf || can('members.remove')
          ? h(
              'button',
              {
                class: 'danger',
                onclick: () => {
                  if (!confirm(m.isSelf ? 'この案件から退出しますか' : 'この参加者を案件から解除しますか')) return;
                  run(async () => {
                    await api('DELETE', `/projects/${id}/members/${m.id}`);
                    if (m.isSelf) location.hash = '#/projects';
                    else await reload();
                  });
                },
              },
              m.isSelf ? '退出' : '解除',
            )
          : null,
      ),
    ),
  );
  parts.push(h('section', {}, h('h3', {}, '参加者'), h('table', {}, h('tbody', {}, memberRows))));

  if (can('invitations.manage')) parts.push(await invitationsSection(id));
  main().replaceChildren(...parts);
}

async function invitationsSection(id) {
  const inviteResult = h('div');
  const list = h('tbody');
  const refresh = async () => {
    const { invitations } = await api('GET', `/projects/${id}/invitations`);
    list.replaceChildren(
      ...invitations.map((i) =>
        h(
          'tr',
          {},
          h('td', {}, { pending: '未使用', accepted: '使用済み', revoked: '取消', expired: '期限切れ' }[i.status] ?? i.status),
          h('td', {}, `${fmt(i.expiresAt)}まで`),
          h('td', {}, i.status === 'pending' ? h('button', { class: 'danger', onclick: () => run(async () => { await api('DELETE', `/projects/${id}/invitations/${i.id}`); await refresh(); }) }, '取消') : null),
        ),
      ),
    );
  };
  await refresh();
  return h(
    'section',
    {},
    h('h3', {}, '招待'),
    h('p', { class: 'muted' }, '招待リンクは1人だけが使え、72時間で失効します。参加した人は参加者になります。'),
    h(
      'button',
      {
        class: 'primary',
        onclick: () =>
          run(async () => {
            const res = await api('POST', `/projects/${id}/invitations`);
            // トークンはURLのフラグメントに入れ、サーバーのアクセスログやRefererに残らないようにする
            const url = `${location.origin}/#invite=${res.token}`;
            inviteResult.replaceChildren(
              h('p', {}, '招待リンク（この画面でのみ表示されます）'),
              h('div', { class: 'row' }, h('input', { class: 'mono', value: url, readonly: true, size: 60 }), h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(url).then(() => notify('コピーしました')) }, 'コピー')),
            );
            await refresh();
          }),
      },
      '招待リンクを発行',
    ),
    inviteResult,
    h('table', {}, list),
  );
}

async function renderAccount() {
  const [{ passkeys }, plan] = await Promise.all([api('GET', '/account/passkeys'), api('GET', '/account/deletion-plan')]);
  const reload = () => renderAccount();
  main().replaceChildren(
    h('h2', {}, 'Passkey'),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, '登録日時'), h('th', {}, '最終使用'), h('th', {}, '同期'), h('th', {}))),
      h('tbody', {}, passkeys.map((p) =>
        h(
          'tr',
          {},
          h('td', { class: 'mono' }, `${p.credential_id_prefix}…`),
          h('td', {}, fmt(p.created_at)),
          h('td', {}, fmt(p.last_used_at)),
          h('td', {}, p.backed_up ? 'あり' : 'なし'),
          h('td', {}, h('button', {
            class: 'danger',
            disabled: passkeys.length <= 1,
            onclick: () => { if (confirm('このPasskeyを削除しますか')) run(async () => { await api('DELETE', `/account/passkeys/${p.id}`); await reload(); }, '削除しました'); },
          }, '削除')),
        ),
      )),
    ),
    h('p', { class: 'muted' }, 'すべてのPasskeyを失うとアカウントは復旧できません。別の端末やセキュリティキーにも登録してください。'),
    h('button', {
      class: 'primary',
      onclick: () => run(async () => {
        const optionsJSON = await api('POST', '/account/passkeys/options');
        const response = await startRegistration({ optionsJSON });
        await api('POST', '/account/passkeys/verify', { response });
        await reload();
      }, 'Passkeyを追加しました'),
    }, 'Passkeyを追加'),
    h('h2', {}, 'アカウント削除'),
    plan.blockingProjectIds.length
      ? h('p', { class: 'error' }, `他の参加者がいる案件の唯一の管理者です（${plan.blockingProjectIds.length}件）。他の参加者を解除するまで削除できません。`)
      : null,
    h('p', {}, `削除される案件: ${plan.projectsToDelete.length}件（他に参加者がいない案件） / 退出する案件: ${plan.projectsToLeave.length}件`),
    h('button', {
      class: 'danger',
      disabled: plan.blockingProjectIds.length > 0,
      onclick: () => {
        if (!confirm('アカウントを削除します。元に戻せません')) return;
        run(async () => {
          await api('DELETE', '/account', { confirm: true });
          authenticated = false;
          csrf = null;
          await refreshSession();
          location.hash = '#/';
          await route();
        }, 'アカウントを削除しました');
      },
    }, 'アカウントを削除'),
  );
}

// ---- ルーティング ----

async function route() {
  const hash = location.hash;
  // 招待トークンは取り出したらURLから消す
  if (hash.startsWith('#invite=')) {
    sessionStorage.setItem(INVITE_KEY, hash.slice('#invite='.length));
    history.replaceState(null, '', '/#/invite');
  }
  document.getElementById('nav').hidden = !authenticated;
  if (!authenticated) return renderLogin();
  const path = location.hash.slice(1);
  try {
    if (path === '/invite') return renderInvite();
    if (path.startsWith('/p/')) return await renderProject(path.slice(3));
    if (path === '/account') return await renderAccount();
    return await renderProjects();
  } catch (err) {
    notify(ERRORS[err?.code] ?? `エラー: ${err?.code ?? err?.message}`, true);
    main().replaceChildren();
  }
}

document.getElementById('logout').addEventListener('click', () =>
  run(async () => {
    await api('POST', '/auth/logout');
    authenticated = false;
    csrf = null;
    await refreshSession();
    location.hash = '#/';
    await route();
  }),
);
window.addEventListener('hashchange', () => route());

await refreshSession();
await route();
