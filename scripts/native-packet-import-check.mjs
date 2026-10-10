#!/usr/bin/env node
// Offline custody/import check. Never invoke a staged module as its CLI main.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire, syncBuiltinESMExports} from 'node:module';
import {dirname, join, resolve, relative} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const self = fileURLToPath(import.meta.url);
const sha = b => createHash('sha256').update(b).digest('hex');
const check = (ok, message) => {if (!ok) throw Error(message);};

async function inertImport(file) {
  const require = createRequire(import.meta.url), attempts = [];
  const packet = dirname(resolve(file)), reads = [], openSync = fs.openSync;
  const deny = name => () => {attempts.push(name); throw Error('IMPORT_ACTION_BLOCKED: '+name);};
  const patch = (module, names) => {for (const name of names) if (typeof module[name] === 'function') module[name] = deny(name);};
  patch(require('node:child_process'), ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']);
  patch(require('node:net'), ['connect','createConnection','createServer']);
  patch(require('node:net').Socket.prototype, ['connect']);
  patch(require('node:net').Server.prototype, ['listen']);
  patch(require('node:tls'), ['connect','createServer']);
  patch(require('node:dgram'), ['createSocket']);
  for (const name of ['http','https']) patch(require('node:'+name), ['request','get','createServer']);
  const mutations = ['write','writeFile','appendFile','mkdir','mkdtemp','rename','unlink','rm','rmdir','chmod','chown','truncate','symlink','link','copyFile','cp','utimes'];
  patch(fs, [...mutations, ...mutations.map(n => n+'Sync'), 'open','openSync','createWriteStream','createReadStream']);
  patch(fs.promises, [...mutations, 'open']);
  fs.openSync = (path, flags, ...rest) => {
    const p = resolve(path instanceof URL ? fileURLToPath(path) : String(path)), local = relative(packet,p);
    if ((flags === 'r' || flags === 0) && local && !local.startsWith('..') && !local.startsWith('/') && fs.lstatSync(p).isFile() && fs.realpathSync(p) === p) {
      reads.push(local); return openSync(p,flags,...rest);
    }
    return deny('openSync outside regular read-only packet file')();
  };
  process.kill = deny('process.kill'); process.chdir = deny('process.chdir');
  globalThis.fetch = deny('fetch'); globalThis.WebSocket = deny('WebSocket');
  syncBuiltinESMExports();
  // Exercise the guards, then count only the actual packet import's attempts.
  const probes = [() => require('node:child_process').spawn('open'), () => require('node:net').connect('/absent'), () => fs.writeFileSync('/absent',''), () => process.kill(1), () => fetch('https://invalid')];
  for (const probe of probes) {try {probe();} catch {}}
  check(attempts.length === probes.length, 'inert-import guards failed self check'); attempts.length = 0;
  let error = null;
  try {await import(pathToFileURL(resolve(file)).href);} catch (e) {error = {code:e.code ?? null, message:e.message};}
  console.log(JSON.stringify({file:resolve(file), guardedMain:true, guardSelfChecks:probes.length, reads, attempts, error}));
  process.exitCode = error || attempts.length ? 1 : 0;
}

export function checkPacket(root) {
  root = resolve(root);
  const manifestBytes = fs.readFileSync(join(root,'invocation-manifest.json'));
  const manifest = JSON.parse(manifestBytes), packet = join(root,'invocation-packet');
  const ts = createRequire(import.meta.url)('typescript');
  const errors = [], dependencies = [], imports = [], files = Object.keys(manifest.files).sort();
  const attempt = fn => {try {fn();} catch (e) {errors.push(e.message);}};
  attempt(() => check(JSON.stringify(fs.readdirSync(packet).sort()) === JSON.stringify(files), 'packet/manifest filename set differs'));
  for (const name of files) attempt(() => {
    check(/^[A-Za-z0-9.-]+$/.test(name), 'unsafe manifest filename: '+name);
    const p = join(packet,name), s = fs.lstatSync(p), pin = manifest.files[name];
    check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, 'regular single-link packet file required: '+name);
    check(s.size === pin.bytes && sha(fs.readFileSync(p)) === pin.sha256, 'packet hash/size differs: '+name);
    check(pin.remotePath === join(manifest.stage,name), 'remote filename differs: '+name);
  });
  const requireFile = (importer, specifier, kind) => {
    const name = relative(packet,resolve(dirname(join(packet,importer)),specifier));
    dependencies.push({importer,specifier,name,kind});
    check(!name.startsWith('..') && manifest.files[name] && fs.existsSync(join(packet,name)), 'unmanifested dependency '+importer+' -> '+specifier);
  };
  for (const name of files.filter(n => n.endsWith('.mjs'))) attempt(() => {
    const source = fs.readFileSync(join(packet,name),'utf8');
    const ast = ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    check(ast.parseDiagnostics.length === 0, 'packet module syntax invalid: '+name);
    const visit = n => {
      let literal;
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) literal = n.moduleSpecifier;
      if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || n.expression.getText(ast) === 'require')) literal = n.arguments[0];
      if (literal && ts.isStringLiteral(literal) && literal.text.startsWith('.')) attempt(() => requireFile(name,literal.text,'LOCAL_MODULE'));
      // Stage-relative source/executable inputs; output receipts and reviewed private configs are generated later.
      if (ts.isCallExpression(n) && n.expression.getText(ast) === 'join' && n.arguments.length === 2) {
        const base = n.arguments[0].getText(ast), input = n.arguments[1];
        if ((base === 'stage' || base === 'dirname(self)') && ts.isStringLiteral(input) && /(?:\.(?:mjs|swift|command)$|^native-focus-episode$)/.test(input.text)) attempt(() => requireFile(name,'./'+input.text,'STAGED_RUNTIME_INPUT'));
      }
      ts.forEachChild(n,visit);
    }; visit(ast);
    // Real Node resolution/evaluation from the assembled packet, with argv[1] bound to this checker.
    const result = spawnSync(process.execPath,[self,'--inert-import',join(packet,name)],{encoding:'utf8',timeout:15000,env:{PATH:'/usr/bin:/bin'}});
    let receipt;
    try {receipt = JSON.parse(result.stdout.trim());} catch {receipt = {error:result.error?.message ?? result.stderr,attempts:null};}
    imports.push({...receipt,exitCode:result.status,signal:result.signal});
    check(result.status === 0 && receipt.attempts?.length === 0 && !receipt.error, 'inert packet import failed: '+name);
  });
  const episode = JSON.parse(fs.readFileSync(join(packet,'episode.template.json')));
  for (const [name,pin] of Object.entries(episode.sourcePins)) attempt(() => check(manifest.files[name]?.sha256 === pin,'template source pin differs: '+name));
  for (const name of ['boot.mjs','inside-cmux-bootstrap.mjs']) attempt(() => check(episode.sourcePins[name] === manifest.files['boot.mjs'].sha256,'bootstrap alias absent/unpinned: '+name));
  attempt(() => check(fs.readFileSync(join(packet,'controller-entry.command'),'utf8') === '#!/bin/sh\nexec '+episode.runner.node+' '+manifest.stage+'/native-controller-entry.mjs --entry\n','entry wrapper filename/path differs'));
  return {status:errors.length ? 'FAIL' : 'PASS',packet,manifestSHA256:sha(manifestBytes),fileCount:files.length,moduleCount:imports.length,dependencies,imports,errors,nativeActions:0,helperExecutions:0,providerCalls:0};
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--inert-import') await inertImport(process.argv[3]);
  else {const receipt = checkPacket(process.argv[2]); console.log(JSON.stringify(receipt,null,2)); process.exitCode = receipt.status === 'PASS' ? 0 : 1;}
}
