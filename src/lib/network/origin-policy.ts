import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { cidrContains, isPublicIpAddress, parseCidr, type OutboundHostLookup } from './outbound-host';

export type OutboundPurpose = 'model' | 'notification' | 'push';

const policyEnvironment: Record<OutboundPurpose, string> = {
  model: 'MODEL_ORIGIN_POLICY',
  notification: 'NOTIFICATION_ORIGIN_POLICY',
  push: 'PUSH_ORIGIN_POLICY',
};

export class OriginPolicyError extends Error {
  constructor(purpose: OutboundPurpose = 'model') {
    super(`Outbound ${purpose} destination is not approved. Ask the instance operator to configure ${policyEnvironment[purpose]}; custom model endpoints require a tenant API key or no key.`);
    this.name = 'OriginPolicyError';
  }
}

/** Reject parser repairs and URL components that are ambiguous for endpoint joining. */
export function modelUrl(value: string, allowSearch = false): URL {
  if (!/^https?:\/\/[^/]/i.test(value) || /[\s\\]/.test(value)) throw new OriginPolicyError();
  let url: URL;
  try { url = new URL(value); } catch { throw new OriginPolicyError(); }
  if (url.username || url.password || url.hash || (!allowSearch && url.search) || url.hostname.endsWith('.')) throw new OriginPolicyError();
  const authority = value.split('/')[2];
  if (authority.includes('@') || authority.includes('%') || authority.endsWith(':')) throw new OriginPolicyError();
  // Reject alternate IPv4 spellings (integer, octal, hex, shortened forms).
  const rawHost = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
  if (isIP(url.hostname) === 4 && rawHost !== url.hostname) throw new OriginPolicyError();
  return url;
}

type Rule = { origin: string; addresses?: string[] };

/** Purpose-specific deployment configuration; never read notification or tenant settings. */
function originRules(purpose: OutboundPurpose): Rule[] {
  const defaults: Rule[] = purpose === 'model' ? [{ origin: 'https://api.openai.com' }, { origin: 'https://api.anthropic.com' }] : purpose === 'push' ? [
    { origin: 'https://fcm.googleapis.com' },
    { origin: 'https://updates.push.services.mozilla.com' },
    { origin: 'https://web.push.apple.com' },
  ] : [];
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
  if (purpose === 'push' && url.protocol !== 'https:') throw new OriginPolicyError(purpose);
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
  const result = await postWithPolicy(purpose, endpoint, headers, body, limits);
  if (result.status < 200 || result.status >= 300) throw new Error('Provider returned an unsuccessful status');
  return JSON.parse(result.body);
}

export async function postWithPolicy(purpose: OutboundPurpose, endpoint: string, headers: Record<string, string>, body: string | Buffer,
  limits = { connectMs: 5_000, totalMs: 20_000, responseBytes: 2 * 1024 * 1024 },
): Promise<{ status: number; body: string }> {
  const url = modelUrl(endpoint, purpose === 'push');
  // The total deadline includes DNS resolution and body consumption.
  const signal = AbortSignal.timeout(limits.totalMs);
  const target = await new Promise<Awaited<ReturnType<typeof resolveModelTarget>>>((resolve, reject) => {
    const abort = () => reject(new Error('Model request deadline exceeded'));
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
      if (!response.statusCode || (response.statusCode >= 300 && response.statusCode < 400)) {
        response.destroy();
        reject(new Error('Model provider returned an unsuccessful status'));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.responseBytes) {
          response.destroy(new Error('Model response limit exceeded'));
        } else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Model connection deadline exceeded')), limits.connectMs);
    request.on('socket', socket => socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(timer)));
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(body);
  });
}
