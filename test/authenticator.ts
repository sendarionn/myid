import { createHash, createSign, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

// テスト専用のソフトウェア認証器（ES256・attestation none）
// 実機の Passkey とは異なり、OS・ブラウザのUIや同期の挙動は検証できない

export type VirtualCredential = {
  id: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
  userHandle: string;
  rpId: string;
  signCount: number;
};

type Overrides = {
  origin?: string;
  rpId?: string;
  type?: string;
  challenge?: string;
  userVerified?: boolean;
  userHandle?: string | null;
  credentialId?: string;
  credentialIdBytes?: Buffer;
  ignoreExclude?: boolean;
};

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

function flagsByte(uv: boolean, attested: boolean): number {
  // UP | UV | BE | BS | AT
  return 0x01 | (uv ? 0x04 : 0) | 0x08 | 0x10 | (attested ? 0x40 : 0);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

export class VirtualAuthenticator {
  credentials: VirtualCredential[] = [];
  origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  create(options: PublicKeyCredentialCreationOptionsJSON, o: Overrides = {}): RegistrationResponseJSON {
    const rpId = options.rp.id!;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const id = o.credentialIdBytes ?? randomBytes(32);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(o.rpId ?? rpId),
      Buffer.from([flagsByte(o.userVerified ?? true, true)]),
      u32(0),
      Buffer.alloc(16),
      credIdLen,
      id,
      Buffer.from(cose),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, string> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = JSON.stringify({
      type: o.type ?? 'webauthn.create',
      challenge: o.challenge ?? options.challenge,
      origin: o.origin ?? this.origin,
      crossOrigin: false,
    });
    const excluded = (options.excludeCredentials ?? []).map((c) => c.id);
    if (!o.ignoreExclude && excluded.length && this.credentials.some((c) => excluded.includes(c.id.toString('base64url')))) {
      throw new Error('InvalidStateError: credential already registered');
    }
    this.credentials.push({ id, privateKey, publicKey, userHandle: options.user.id, rpId, signCount: 0 });
    const idB64 = id.toString('base64url');
    return {
      id: idB64,
      rawId: idB64,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: Buffer.from(clientDataJSON).toString('base64url'),
        attestationObject: Buffer.from(attestationObject).toString('base64url'),
        transports: ['internal'],
      },
    };
  }

  get(
    options: PublicKeyCredentialRequestOptionsJSON,
    credential: VirtualCredential = this.credentials[0]!,
    o: Overrides = {},
  ): AuthenticationResponseJSON {
    credential.signCount += 1;
    const authData = Buffer.concat([
      sha256(o.rpId ?? credential.rpId),
      Buffer.from([flagsByte(o.userVerified ?? true, false)]),
      u32(credential.signCount),
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: o.type ?? 'webauthn.get',
        challenge: o.challenge ?? options.challenge,
        origin: o.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
    const signer = createSign('SHA256');
    signer.update(Buffer.concat([authData, sha256(clientDataJSON)]));
    const signature = signer.sign(credential.privateKey);
    const id = o.credentialId ?? credential.id.toString('base64url');
    const userHandle = o.userHandle === undefined ? credential.userHandle : o.userHandle;
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        ...(userHandle === null ? {} : { userHandle }),
      },
    };
  }
}
