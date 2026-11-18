import fs from 'node:fs';
import path from 'node:path';

export function evaluate(report, scope, exceptions, now = new Date()) {
  if (report.SchemaVersion !== 2 || !Array.isArray(report.Results)) throw Error(`${scope}: incomplete scanner report`);
  for (const r of report.Results) {
    if (!r || typeof r.Target !== 'string' ||
        (r.Packages != null && !Array.isArray(r.Packages)) ||
        (r.Vulnerabilities != null && !Array.isArray(r.Vulnerabilities))) throw Error('Malformed scan result');
  }
  const packages = report.Results.flatMap(r => r.Packages ?? []);
  if (packages.some(p => !p.Name || !p.Version)) throw Error('Incomplete package entry');
  if (!packages.length) throw Error(`${scope}: missing package inventory`);
  if (!['source', 'runtime', 'migrate'].includes(scope)) throw Error('Unknown inventory scope');
  const required = scope === 'runtime' ? ['next', '@prisma/client', 'pg', 'tsx'] : ['next', '@prisma/client', 'prisma'];
  for (const name of required) {
    if (!packages.some(p => p.Name === name && p.Version)) throw Error(`${scope}: missing inventory package ${name}`);
  }
  if (scope === 'runtime' && packages.some(p => ['prisma', '@prisma/config', '@prisma/dev'].includes(p.Name))) throw Error('Migration tooling leaked into runtime');
  if (scope !== 'source' && (!report.Metadata?.ImageID || !report.Results.some(r => r.Class === 'os-pkgs' && r.Packages?.length))) {
    throw Error(`${scope}: missing image identity or OS inventory`);
  }
  if (scope === 'source' && !report.Results.some(r => r.Target === 'package-lock.json')) throw Error('Missing lockfile scan');
  const findings = report.Results.flatMap(r => (r.Vulnerabilities ?? []).map(v => ({
    scope, target: r.Target, id: v.VulnerabilityID, package: v.PkgName,
    version: v.InstalledVersion, severity: v.Severity,
  })));
  for (const finding of findings) {
    if (!finding.id || !finding.package || !finding.version || !finding.severity) throw Error('Malformed finding');
    finding.accepted = exceptions.some(e => ['scope', 'id', 'package', 'version'].every(k => e[k] === finding[k]));
  }
  return {
    scope, packages, findings, scannedAt: now.toISOString(), revision: process.env.GITHUB_SHA ?? null,
    image: scope === 'source' ? null : {
      id: report.Metadata.ImageID, digests: report.Metadata.RepoDigests ?? [], os: report.Metadata.OS,
    },
  };
}

export function validateExceptions(document, now = new Date()) {
  if (!Array.isArray(document.exceptions)) throw Error('Missing exception list');
  const keys = new Set();
  for (const e of document.exceptions) {
    if (!['source', 'runtime', 'migrate'].includes(e.scope) ||
        ['id', 'package', 'version', 'owner', 'reason', 'expires'].some(k => typeof e[k] !== 'string' || !e[k].trim()) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(e.expires) || !Number.isFinite(Date.parse(e.expires)) ||
        new Date(e.expires).toISOString().slice(0, 10) !== e.expires || Date.parse(e.expires) <= now.getTime()) {
      throw Error('Invalid or expired exception; owner, reason and future expiry required');
    }
    const key = [e.scope, e.id, e.package, e.version].join(':');
    if (keys.has(key)) throw Error('Duplicate exception');
    keys.add(key);
  }
  return document.exceptions;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [scope, input, output] = process.argv.slice(2);
  try {
    const exceptions = validateExceptions(JSON.parse(fs.readFileSync('.github/security/exceptions.json')));
    const result = evaluate(JSON.parse(fs.readFileSync(input)), scope, exceptions);
    // Secret match text is never copied into published evidence.
    const secrets = JSON.parse(fs.readFileSync(path.join(path.dirname(input), `${scope}-secrets.json`)));
    if (secrets.SchemaVersion !== 2 || (secrets.Results != null && !Array.isArray(secrets.Results))) throw Error('Incomplete secret report');
    for (const r of secrets.Results ?? []) {
      if (!r || (r.Secrets != null && !Array.isArray(r.Secrets))) throw Error('Malformed secret result');
    }
    result.secretFindings = (secrets.Results ?? []).reduce((n, r) => n + (r.Secrets ?? []).length, 0);
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    const blocked = result.findings.filter(f => !f.accepted);
    console.log(`${scope}: ${result.packages.length} packages, ${blocked.length} unaccepted vulnerabilities, ${result.secretFindings} secrets`);
    if (blocked.length || result.secretFindings) throw Error('Reviewer decision or remediation required; see sanitized inventory');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
