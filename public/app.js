import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '/vendor/simplewebauthn/index.js';

const PERMISSIONS = [
  ['project.view', '基本情報 閲覧'],
  ['project.edit', '基本情報 編集'],
  ['details.view', '製品・作業予定 閲覧'],
  ['details.edit', '製品・作業予定 編集'],
  ['contract.view', '契約 閲覧'],
  ['contract.edit', '契約 編集'],
  ['events.view', 'イベント 閲覧'],
  ['members.manage', '参加者管理'],
];
const ROLES = [
  ['customer', '顧客'],
  ['contractor', '契約担当'],
  ['installer', '施工担当'],
  ['maintainer', '保守担当'],
  ['other', 'その他'],
];
const STATUSES = [
  ['planning', '計画中'],
  ['active', '進行中'],
  ['on_hold', '保留'],
  ['completed', '完了'],
  ['cancelled', '中止'],
];
const WORK_TYPES = [
  ['site_survey', '現地調査'],
  ['installation', '施工'],
  ['maintenance', '保守'],
];
const BILLING = [
  ['not_billed', '未請求'],
  ['billed', '請求済み'],
  ['paid', '入金済み'],
];
const ERRORS = {
  verification_failed: 'Passkeyの検証に失敗しました',
  credential_already_registered: 'このPasskeyは登録済みです',
  last_passkey: '最後のPasskeyは削除できません',
  last_manager: '管理者が0人になる変更はできません',
  invitation_invalid: '招待が無効か期限切れです',
  already_member: '既にこの案件に参加しています',
  sole_manager_of_shared_project: '他の参加者がいる案件の唯一の管理者です。先に管理権限を移譲してください',
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

const select = (name, options, value) =>
  h('select', { name }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

const permissionBoxes = (checked = []) =>
  h(
    'div',
    { class: 'perms' },
    PERMISSIONS.map(([p, l]) => h('label', {}, h('input', { type: 'checkbox', name: 'perm', value: p, checked: checked.includes(p) }), ' ', l)),
  );

const checkedPermissions = (form) => [...form.querySelectorAll('input[name="perm"]:checked')].map((i) => i.value);
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
                notify(res.membershipStatus === 'pending_approval' ? '参加を申請しました。管理者の承認後に閲覧できます' : '案件に参加しました');
                location.hash = res.membershipStatus === 'active' ? `#/p/${res.projectId}` : '#/projects';
              }),
          },
          '受諾',
        ),
        h('button', { onclick: () => { sessionStorage.removeItem(INVITE_KEY); location.hash = '#/projects'; } }, '破棄'),
      ),
    ),
  );
}

async function renderProjects(q = '') {
  const data = await api('GET', `/projects${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const rows = data.projects.map((p) =>
    h(
      'tr',
      {},
      h('td', {}, p.membershipStatus === 'active' ? h('a', { href: `#/p/${p.id}` }, p.name ?? '（名前の閲覧権限なし）') : '承認待ち'),
      h('td', {}, p.status ? label(STATUSES, p.status) : ''),
      h('td', {}, label(ROLES, p.role)),
    ),
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
    h(
      'form',
      { onsubmit: (e) => { e.preventDefault(); run(() => renderProjects(new FormData(e.target).get('q'))); } },
      h('input', { name: 'q', value: q, placeholder: '案件名で検索', type: 'search' }),
      h('button', {}, '検索'),
      h('span', { class: 'muted' }, `${data.total}件`),
    ),
    rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '案件名'), h('th', {}, '状態'), h('th', {}, '役割'))), h('tbody', {}, rows))
      : h('p', { class: 'muted' }, '参加している案件はありません'),
  );
}

async function renderProject(id) {
  const detail = await api('GET', `/projects/${id}`);
  const can = (p) => detail.access.permissions.includes(p);
  const reload = () => renderProject(id);
  const parts = [];

  parts.push(
    h('h2', {}, detail.project?.name ?? '案件'),
    h('p', { class: 'muted' }, `役割: ${label(ROLES, detail.access.role)} / 権限: ${detail.access.permissions.map((p) => label(PERMISSIONS, p)).join('、') || 'なし'}`),
  );

  if (detail.project) {
    const basic = h('section', {}, h('h3', {}, '基本情報'), h('p', {}, `状態: ${label(STATUSES, detail.project.status)}`));
    if (can('project.edit')) {
      basic.append(
        h(
          'form',
          {
            onsubmit: (e) => {
              e.preventDefault();
              const f = new FormData(e.target);
              run(async () => { await api('PATCH', `/projects/${id}`, { name: f.get('name'), status: f.get('status') }); await reload(); }, '更新しました');
            },
          },
          h('input', { name: 'name', value: detail.project.name, required: true, maxlength: 100 }),
          select('status', STATUSES, detail.project.status),
          h('button', {}, '更新'),
        ),
      );
    }
    parts.push(basic);
  }

  if (can('details.view')) {
    const [{ products }, { schedules }] = await Promise.all([
      api('GET', `/projects/${id}/products`),
      api('GET', `/projects/${id}/schedules`),
    ]);
    const sec = h(
      'section',
      {},
      h('h3', {}, '製品'),
      products.length ? h('ul', {}, products.map((p) => h('li', {}, `${p.productCode} × ${p.quantity}`))) : h('p', { class: 'muted' }, 'なし'),
    );
    if (can('details.edit')) {
      sec.append(
        h(
          'form',
          {
            onsubmit: (e) => {
              e.preventDefault();
              const f = new FormData(e.target);
              run(async () => { await api('POST', `/projects/${id}/products`, { productCode: f.get('productCode'), quantity: Number(f.get('quantity')) }); await reload(); });
            },
          },
          h('input', { name: 'productCode', required: true, maxlength: 64, placeholder: '製品コード・型番' }),
          h('input', { name: 'quantity', type: 'number', min: 1, max: 10000, value: 1, required: true }),
          h('button', {}, '追加'),
        ),
      );
    }
    sec.append(
      h('h3', {}, '作業予定'),
      schedules.length ? h('ul', {}, schedules.map((s) => h('li', {}, `${s.scheduledOn} ${label(WORK_TYPES, s.workType)}`))) : h('p', { class: 'muted' }, 'なし'),
    );
    if (can('details.edit')) {
      sec.append(
        h(
          'form',
          {
            onsubmit: (e) => {
              e.preventDefault();
              const f = new FormData(e.target);
              run(async () => { await api('POST', `/projects/${id}/schedules`, { workType: f.get('workType'), scheduledOn: f.get('scheduledOn') }); await reload(); });
            },
          },
          select('workType', WORK_TYPES, 'installation'),
          h('input', { name: 'scheduledOn', type: 'date', required: true }),
          h('button', {}, '追加'),
        ),
      );
    }
    parts.push(sec);
  }

  if (can('contract.view')) {
    const { contract } = await api('GET', `/projects/${id}/contract`);
    const sec = h(
      'section',
      {},
      h('h3', {}, '契約（ダミー）'),
      contract
        ? h('p', {}, `${contract.contractReference} / ${Number(contract.amountJpy).toLocaleString()}円 / ${label(BILLING, contract.billingStatus)}`)
        : h('p', { class: 'muted' }, '未登録'),
    );
    if (can('contract.edit')) {
      sec.append(
        h(
          'form',
          {
            onsubmit: (e) => {
              e.preventDefault();
              const f = new FormData(e.target);
              run(async () => {
                await api('PUT', `/projects/${id}/contract`, { contractReference: f.get('ref'), amountJpy: Number(f.get('amount')), billingStatus: f.get('billing') });
                await reload();
              });
            },
          },
          h('input', { name: 'ref', required: true, maxlength: 64, placeholder: '契約番号', value: contract?.contractReference ?? '' }),
          h('input', { name: 'amount', type: 'number', min: 0, required: true, placeholder: '金額', value: contract?.amountJpy ?? '' }),
          select('billing', BILLING, contract?.billingStatus ?? 'not_billed'),
          h('button', {}, '保存'),
        ),
      );
    }
    parts.push(sec);
  }

  if (can('events.view')) {
    const { events } = await api('GET', `/projects/${id}/events`);
    parts.push(
      h(
        'section',
        {},
        h('h3', {}, 'イベント'),
        h(
          'table',
          {},
          h('tbody', {}, events.map((e) =>
            h('tr', {}, h('td', {}, fmt(e.occurredAt)), h('td', {}, e.eventType), h('td', {}, e.statusTo ? `${label(STATUSES, e.statusFrom)} → ${label(STATUSES, e.statusTo)}` : '')),
          )),
        ),
      ),
    );
  }

  if (can('members.manage')) parts.push(await membersSection(id, reload));

  parts.push(
    h(
      'section',
      {},
      h('h3', {}, '退出'),
      h(
        'button',
        {
          class: 'danger',
          onclick: () => {
            if (!confirm('この案件から退出しますか')) return;
            run(async () => { await api('DELETE', `/projects/${id}/members/${detail.access.membershipId}`); location.hash = '#/projects'; }, '退出しました');
          },
        },
        'この案件から退出',
      ),
    ),
  );
  main().replaceChildren(...parts);
}

async function membersSection(id, reload) {
  const [{ members }, { invitations }, { audit }] = await Promise.all([
    api('GET', `/projects/${id}/members`),
    api('GET', `/projects/${id}/invitations`),
    api('GET', `/projects/${id}/audit`),
  ]);
  const shortId = (v) => (v ? v.slice(0, 8) : '');

  const memberRows = members.map((m) => {
    const form = h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const f = e.target;
          run(async () => {
            await api('PATCH', `/projects/${id}/members/${m.id}`, { role: new FormData(f).get('role'), permissions: checkedPermissions(f) });
            await reload();
          }, '更新しました');
        },
      },
      select('role', ROLES, m.role),
      permissionBoxes(m.permissions),
      h('button', {}, '更新'),
      m.status === 'pending_approval'
        ? h('button', { type: 'button', class: 'primary', onclick: () => run(async () => { await api('POST', `/projects/${id}/members/${m.id}/approve`); await reload(); }) }, '承認')
        : null,
      h(
        'button',
        {
          type: 'button',
          class: 'danger',
          onclick: () => {
            if (!confirm(m.isSelf ? 'この案件から退出しますか' : 'この参加者の権限を失効しますか')) return;
            run(async () => { await api('DELETE', `/projects/${id}/members/${m.id}`); if (m.isSelf) location.hash = '#/projects'; else await reload(); });
          },
        },
        m.isSelf ? '退出' : '失効',
      ),
    );
    return h(
      'tr',
      {},
      h('td', { class: 'mono' }, shortId(m.id), m.isSelf ? h('div', { class: 'muted' }, '自分') : null),
      h('td', {}, m.status === 'active' ? '有効' : '承認待ち', m.validUntil ? h('div', { class: 'muted' }, `${fmt(m.validUntil)}まで`) : null),
      h('td', {}, form),
    );
  });

  const inviteResult = h('div');
  const inviteForm = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const f = e.target;
        const fd = new FormData(f);
        run(async () => {
          const res = await api('POST', `/projects/${id}/invitations`, {
            role: fd.get('role'),
            permissions: checkedPermissions(f),
            ttlHours: Number(fd.get('ttl')),
            requiresApproval: fd.get('approval') === 'on',
          });
          // トークンはURLのフラグメントに入れ、サーバーのアクセスログやRefererに残らないようにする
          const url = `${location.origin}/#invite=${res.token}`;
          inviteResult.replaceChildren(
            h('p', {}, '招待リンク（この画面でのみ表示されます）'),
            h('div', { class: 'row' }, h('input', { class: 'mono', value: url, readonly: true, size: 60 }), h('button', { type: 'button', onclick: () => navigator.clipboard.writeText(url).then(() => notify('コピーしました')) }, 'コピー')),
          );
          await refreshInvitations();
        });
      },
    },
    select('role', ROLES, 'installer'),
    permissionBoxes(['project.view']),
    h('label', {}, '有効期限 ', h('select', { name: 'ttl' }, [1, 24, 72, 168].map((v) => h('option', { value: v, selected: v === 72 }, `${v}時間`)))),
    h('label', {}, h('input', { type: 'checkbox', name: 'approval' }), ' 参加に承認を要求'),
    h('button', { class: 'primary' }, '招待リンクを発行'),
  );

  const invitationsBody = h('tbody');
  const fillInvitations = (list) =>
    invitationsBody.replaceChildren(
      ...list.map((i) =>
        h(
          'tr',
          {},
          h('td', {}, label(ROLES, i.role)),
          h('td', {}, { pending: '未使用', accepted: '使用済み', revoked: '取消', expired: '期限切れ' }[i.status] ?? i.status),
          h('td', {}, fmt(i.expiresAt)),
          h('td', {}, i.status === 'pending' ? h('button', { class: 'danger', onclick: () => run(async () => { await api('DELETE', `/projects/${id}/invitations/${i.id}`); await refreshInvitations(); }) }, '取消') : null),
        ),
      ),
    );
  const refreshInvitations = async () => fillInvitations((await api('GET', `/projects/${id}/invitations`)).invitations);
  fillInvitations(invitations);

  return h(
    'section',
    {},
    h('h3', {}, '参加者'),
    h('table', {}, h('tbody', {}, memberRows)),
    h('h3', {}, '招待'),
    inviteForm,
    inviteResult,
    h('table', {}, invitationsBody),
    h('h3', {}, '変更履歴'),
    h(
      'table',
      {},
      h('tbody', {}, audit.map((a) =>
        h('tr', {}, h('td', {}, fmt(a.occurredAt)), h('td', {}, a.action), h('td', { class: 'mono' }, `${shortId(a.actorMembershipId)} → ${shortId(a.targetMembershipId)}`), h('td', {}, (a.permissions ?? []).join(', '))),
      )),
    ),
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
      ? h('p', { class: 'error' }, `他の参加者がいる案件の唯一の管理者です（${plan.blockingProjectIds.length}件）。管理権限を移譲するまで削除できません。`)
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
