import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { cidrContains, isPublicIpAddress, parseCidr, type OutboundHostLookup } from './outbound-host';

export type OutboundPurpose = 'model' | 'notification';

const policyEnvironment: Record<OutboundPurpose, string> = {
  model: 'MODEL_ORIGIN_POLICY',
  notification: 'NOTIFICATION_ORIGIN_POLICY',
};

export class OriginPolicyError extends Error {
  constructor(purpose: OutboundPurpose = 'model') {
    super(`Outbound ${purpose} destination is not approved. Ask the instance operator to configure ${policyEnvironment[purpose]}; ${purpose === 'model' ? 'custom model endpoints require a tenant API key or no key.' : 'notification approval is separate from model approval.'}`);
    this.name = 'OriginPolicyError';
  }
}

/** Reject parser repairs and URL components that are ambiguous for endpoint joining. */
export function modelUrl(value: string): URL {
  return outboundUrl(value, 'model');
}

function outboundUrl(value: string, purpose: OutboundPurpose): URL {
  if (!/^https?:\/\/[^/]/i.test(value) || /[\s\\]/.test(value)) throw new OriginPolicyError(purpose);
  let url: URL;
  try { url = new URL(value); } catch { throw new OriginPolicyError(purpose); }
  if (url.username || url.password || url.hash || (purpose === 'model' && url.search) || url.hostname.endsWith('.')) throw new OriginPolicyError(purpose);
  const authority = value.split('/')[2];
  if (authority.includes('@') || authority.includes('%') || authority.endsWith(':')) throw new OriginPolicyError(purpose);
  // Reject alternate IPv4 spellings (integer, octal, hex, shortened forms).
  const rawHost = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
  if (isIP(url.hostname) === 4 && rawHost !== url.hostname) throw new OriginPolicyError(purpose);
  return url;
}

type Rule = { origin: string; addresses?: string[] };

/** Purpose-specific deployment configuration; never read notification or tenant settings. */
function originRules(purpose: OutboundPurpose): Rule[] {
  const defaults: Rule[] = purpose === 'model' ? [{ origin: 'https://api.openai.com' }, { origin: 'https://api.anthropic.com' }] : [];
  const configured = process.env[policyEnvironment[purpose]];
  if (!configured) return defaults;
  try {
    const input: unknown = JSON.parse(configured);
    if (!Array.isArray(input)) throw new Error();
    return input.map((rule) => {
      if (!rule || typeof rule.origin !== 'string' || Object.keys(rule).some(key => key !== 'origin' && key !== 'addresses')) throw new Error();
      const url = modelUrl(rule.origin);
      if (url.pathname !== '/' || (rule.addresses !== undefined && (!Array.isArray(rule.addresses) || rule.addresses.length === 0 || !rule.addresses.every((v: unknown) => typeof v === 'string' && parseCidr(v))))) throw new Error();
      return { origin: url.origin, addresses: rule.addresses };
    });
  } catch {
    throw new OriginPolicyError(purpose);
  }
}

export async function resolveModelTarget(url: URL, dns: OutboundHostLookup = lookup as OutboundHostLookup) {
  return resolveOriginTarget('model', url, dns);
}

export async function resolveOriginTarget(purpose: OutboundPurpose, url: URL, dns: OutboundHostLookup = lookup as OutboundHostLookup) {
  const rule = originRules(purpose).find(rule => rule.origin === url.origin);
  if (!rule) throw new OriginPolicyError(purpose);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const answers = family ? [{ address: host, family }] : await dns(host, { all: true, verbatim: false });
  const ranges = rule.addresses?.map(value => parseCidr(value)!);
  if (!answers.length || answers.some(answer => isIP(answer.address) !== answer.family ||
    (ranges ? !ranges.some(range => range.family === answer.family && cidrContains(range, answer.address)) : !isPublicIpAddress(answer.address)))) throw new OriginPolicyError(purpose);
  return answers[0];
}

/** Direct connections only: no environment proxies, redirects, retries or pooled DNS. */
export async function modelPostJson(endpoint: string, headers: Record<string, string>, body: string,
  limits = { connectMs: 5_000, totalMs: 20_000, responseBytes: 2 * 1024 * 1024 },
): Promise<unknown> {
  return postJsonWithPolicy('model', endpoint, headers, body, limits);
}

/** Callers must choose their purpose; model callers never use notification approval. */
export async function postJsonWithPolicy(purpose: OutboundPurpose, endpoint: string, headers: Record<string, string>, body: string,
  limits = { connectMs: 5_000, totalMs: 20_000, responseBytes: 2 * 1024 * 1024 },
): Promise<unknown> {
  return requestWithPolicy(purpose, endpoint, headers, body, limits, true);
}

/** Notification replies need not be JSON; discard them under a smaller byte cap. */
export async function notificationPost(endpoint: string, headers: Record<string, string>, body: string,
  limits = { connectMs: 5_000, totalMs: 20_000, responseBytes: 64 * 1024 },
): Promise<{ statusCode: number }> {
  return requestWithPolicy('notification', endpoint, headers, body, limits, false) as Promise<{ statusCode: number }>;
}

async function requestWithPolicy(purpose: OutboundPurpose, endpoint: string, headers: Record<string, string>, body: string,
  limits: { connectMs: number; totalMs: number; responseBytes: number }, parseJson: boolean,
): Promise<unknown> {
  const url = outboundUrl(endpoint, purpose);
  // Never permit callers to change authority, framing, proxy routing or upgrades.
  const forbidden = /^(host|:.*|connection|content-length|transfer-encoding|te|trailer|upgrade|expect|proxy-.*|forwarded|x-forwarded-.*|x-original-.*|x-rewrite-.*|x-real-ip|x-http-method-override|x-method-override|via)$/i;
  if (Object.entries(headers).some(([name, value]) => forbidden.test(name) || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n\x00]/.test(value))) {
    throw new Error('Outbound custom header is not permitted');
  }
  // The total deadline includes DNS resolution and body consumption.
  const signal = AbortSignal.timeout(limits.totalMs);
  const target = await new Promise<Awaited<ReturnType<typeof resolveModelTarget>>>((resolve, reject) => {
    const abort = () => reject(new Error('Outbound request deadline exceeded'));
    signal.addEventListener('abort', abort, { once: true });
    resolveOriginTarget(purpose, url).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      method: 'POST', headers, agent: false, signal, family: target.family,
      rejectUnauthorized: true,
      // Preserve the original host for Host, SNI and certificate verification.
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, requestOptions, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        reject(new OutboundStatusError(response.statusCode));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.responseBytes) {
          response.destroy(new Error('Outbound response limit exceeded'));
        } else if (parseJson) chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(parseJson ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : { statusCode: response.statusCode! }); } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Outbound connection deadline exceeded')), limits.connectMs);
    request.on('socket', socket => socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      const remote = socket.remoteAddress?.replace(/^::ffff:/, '');
      const expected = target.address.replace(/^::ffff:/, '');
      const range = parseCidr(expected);
      if (!remote || !range || !cidrContains(range, remote)) request.destroy(new OriginPolicyError(purpose));
    }));
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(body);
  });
}

export class OutboundStatusError extends Error {
  constructor(public readonly statusCode: number | undefined) {
    super('Outbound destination returned an unsuccessful status');
    this.name = 'OutboundStatusError';
  }
}
