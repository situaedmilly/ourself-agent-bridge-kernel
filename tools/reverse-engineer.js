// tools/reverse-engineer.js
// ── Pass 20C · reverse_engineer structured analysis route (NON-TERMINAL) ──────
//
// PURPOSE
//   Give the bridge a SAFE structural lens: read-only, in-process filesystem
//   inspection that returns a strict structured JSON artifact. This is the
//   manifestation of the frozen `reverse_engineer` execution class
//   (mutation:false, terminal:false, analysisOnly:true).
//
// HARD INVARIANTS (enforced by construction — see test/reverse-engineer.test.js)
//   • NO shell. NO terminal. NO executeCommand. NO child_process / spawn / exec.
//   • NO network / remotes. NO writes / mutation of any kind.
//   • Only read-only fs primitives (realpath/readdir/stat/lstat/readFile).
//   • Target MUST resolve inside the RUORA boundary (symlinks resolved first).
//   • Secret-bearing paths are REFUSED and their contents are NEVER read.
//   • Git inventory: single bounded execFileSync for canonical repository state only.
//
//   The bridge may perceive structure without gaining the right to alter it.

import { realpathSync, readdirSync, statSync, lstatSync, readFileSync, existsSync } from 'fs';
import { resolve, isAbsolute, sep, join, relative, basename, extname } from 'path';
import { execFileSync } from 'child_process';
import { RUORA_BOUNDARY, SECRET_PATH } from './execution-classes.js';

// ── Bounds (defensive: analysis must terminate and stay cheap) ───────────────
const MAX_ENTRIES = 4000;          // total dirs + files collected in `structure`
const MAX_DEPTH = 12;              // directory recursion depth
const MAX_CONTENT_SCAN_FILES = 300; // text files whose contents are scanned
const MAX_CONTENT_BYTES = 262144;  // 256 KiB cap per scanned file
const MAX_LIST = 200;              // cap on each signal/risk list
const LARGE_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB → flagged as a risk

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage',
  '.next', '.cache', '.turbo', 'vendor', '.venv', '__pycache__',
]);

const LANG_BY_EXT = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.jsx': 'JavaScript (React)', '.ts': 'TypeScript', '.tsx': 'TypeScript (React)',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.java': 'Java',
  '.kt': 'Kotlin', '.php': 'PHP', '.c': 'C', '.h': 'C', '.cpp': 'C++',
  '.cs': 'C#', '.swift': 'Swift', '.sh': 'Shell', '.sql': 'SQL',
};

const TEXT_SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.sql', '.py', '.go', '.rb']);

const ROOT_IDENTITY_MANIFESTS = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json', '.git', 'README.md', 'README', 'src', 'test', 'tests'];

function isGitRepository(root) {
  try {
    return existsSync(join(root, '.git'));
  } catch {
    return false;
  }
}

function getCanonicalGitInventory(root) {
  try {
    const gitOutput = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return gitOutput.split('\0').filter(p => p.length > 0).sort();
  } catch {
    return null;
  }
}

function detectRootIdentity(root) {
  const detectedManifests = [];
  for (const name of ROOT_IDENTITY_MANIFESTS) {
    try {
      if (existsSync(join(root, name))) {
        detectedManifests.push(name);
      }
    } catch {
      // ignore fs errors for root pass
    }
  }
  return detectedManifests.sort();
}

/**
 * Resolve a requested target path safely:
 *   • secret-bearing paths are refused BEFORE any filesystem access;
 *   • symlinks are resolved (realpath) so a symlink cannot escape the boundary;
 *   • the resolved real path must be the RUORA boundary or inside it.
 * Throws an Error with a stable `.code` on refusal.
 * @param {string} requested
 * @returns {{ requestedPath: string, resolvedPath: string }}
 */
export function resolveTargetWithinBoundary(requested) {
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    const e = new Error('Refused: a non-empty target path is required.');
    e.code = 'missing_target';
    throw e;
  }
  const abs = isAbsolute(requested) ? requested : resolve(RUORA_BOUNDARY, requested);

  // Secret check on the literal path FIRST — never realpath/stat a secret path.
  if (SECRET_PATH.test(requested) || SECRET_PATH.test(abs)) {
    const e = new Error('Refused: target path is secret-bearing (.env / *.pem / credentials / …).');
    e.code = 'secret_path';
    throw e;
  }

  let real;
  try {
    real = realpathSync(abs);
  } catch {
    const e = new Error('Refused: target path does not exist or is unreadable.');
    e.code = 'unresolvable_path';
    throw e;
  }

  // Re-check the realpath too — a symlink could point at a secret file.
  if (SECRET_PATH.test(real)) {
    const e = new Error('Refused: resolved target path is secret-bearing.');
    e.code = 'secret_path';
    throw e;
  }

  if (!(real === RUORA_BOUNDARY || real.startsWith(RUORA_BOUNDARY + sep))) {
    const e = new Error('Refused: target path is outside the RUORA boundary (' + RUORA_BOUNDARY + ').');
    e.code = 'outside_boundary';
    throw e;
  }
  return { requestedPath: requested, resolvedPath: real };
}

function capPush(arr, value) {
  if (arr.length < MAX_LIST && !arr.includes(value)) arr.push(value);
}

/**
 * Perform read-only structural analysis of an in-boundary target and return the
 * strict Pass 20C artifact. Re-validates the boundary/secret guard internally
 * (defense in depth) so the primitive is safe even if called directly.
 * @param {string} requestedPath
 * @param {string} [requestId]
 * @returns {object} the structured analysis artifact
 */
export function analyzeTarget(requestedPath, requestId = 'req') {
  const { requestedPath: reqIn, resolvedPath: root } = resolveTargetWithinBoundary(requestedPath);

  const directories = [];
  const files = [];
  const risks = [];
  const langCount = new Map();
  let truncated = false;

  const rootStat = statSync(root);
  const rootIsDir = rootStat.isDirectory();

  function rel(p) {
    const r = relative(root, p);
    return r === '' ? '.' : r;
  }

  // ── Identity-first root pass: detect project type before recursive traversal ──
  const rootIdentity = detectRootIdentity(root);

  // ── Canonical inventory strategy ─────────────────────────────────────────────
  let inventorySource = null;
  if (rootIsDir) {
    if (isGitRepository(root)) {
      const gitInventory = getCanonicalGitInventory(root);
      if (gitInventory) {
        inventorySource = 'git';
        // Process canonical git inventory
        const fileSet = new Set();
        const dirSet = new Set();
        for (const relPath of gitInventory) {
          if (directories.length + files.length >= MAX_ENTRIES) { truncated = true; break; }
          if (SECRET_PATH.test(relPath)) {
            if (risks.length < MAX_LIST) {
              risks.push({ type: 'secret_file_present', path: relPath, detail: 'excluded from analysis; contents never read' });
            }
            continue;
          }
          const ext = extname(relPath).toLowerCase();
          const lang = LANG_BY_EXT[ext];
          if (lang && !fileSet.has(relPath)) langCount.set(lang, (langCount.get(lang) || 0) + 1);
          fileSet.add(relPath);
          files.push(relPath);

          // Extract directory path
          const dirPath = relPath.substring(0, relPath.lastIndexOf('/'));
          if (dirPath && !dirSet.has(dirPath)) {
            dirSet.add(dirPath);
            if (!SKIP_DIRS.has(basename(dirPath))) {
              directories.push(dirPath);
            }
          }
        }
      }
    }

    // Fallback to bounded filesystem traversal if git inventory unavailable
    if (!inventorySource) {
      inventorySource = 'filesystem';
      function walk(dir, depth) {
        if (depth > MAX_DEPTH) { truncated = true; return; }
        if (directories.length + files.length >= MAX_ENTRIES) { truncated = true; return; }
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
          entries.sort((a, b) => a.name.localeCompare(b.name));
        } catch {
          if (risks.length < MAX_LIST) {
            risks.push({ type: 'unreadable_directory', path: rel(dir), detail: 'directory could not be listed (permissions?)' });
          }
          return;
        }
        for (const ent of entries) {
          if (directories.length + files.length >= MAX_ENTRIES) { truncated = true; return; }
          const full = join(dir, ent.name);

          if (SECRET_PATH.test(full) || SECRET_PATH.test(ent.name)) {
            if (risks.length < MAX_LIST) {
              risks.push({ type: 'secret_file_present', path: rel(full), detail: 'excluded from analysis; contents never read' });
            }
            continue;
          }

          let isSymlink = false;
          try { isSymlink = lstatSync(full).isSymbolicLink(); } catch { /* ignore */ }
          if (isSymlink) {
            let realLink = null;
            try { realLink = realpathSync(full); } catch { /* dangling */ }
            if (!realLink || !(realLink === RUORA_BOUNDARY || realLink.startsWith(RUORA_BOUNDARY + sep))) {
              if (risks.length < MAX_LIST) {
                risks.push({ type: 'symlink_outside_boundary', path: rel(full), detail: 'symlink target outside RUORA boundary; not followed' });
              }
              continue;
            }
          }

          if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) { capPush(directories, rel(full) + '/ (skipped)'); continue; }
            capPush(directories, rel(full));
            walk(full, depth + 1);
          } else if (ent.isFile()) {
            capPush(files, rel(full));
            const ext = extname(ent.name).toLowerCase();
            const lang = LANG_BY_EXT[ext];
            if (lang) langCount.set(lang, (langCount.get(lang) || 0) + 1);
            try {
              const sz = statSync(full).size;
              if (sz > LARGE_FILE_BYTES && risks.length < MAX_LIST) {
                risks.push({ type: 'large_file', path: rel(full), detail: sz + ' bytes (> ' + LARGE_FILE_BYTES + ')' });
              }
            } catch { /* ignore stat errors */ }
          }
        }
      }
      walk(root, 0);
    }
  } else {
    capPush(files, basename(root));
    const lang = LANG_BY_EXT[extname(root).toLowerCase()];
    if (lang) langCount.set(lang, 1);
  }

  // ── Derived summary ─────────────────────────────────────────────────────────
  const fileSet = new Set(files);
  const has = (name) => fileSet.has(name);

  let project_type = 'unknown';
  if (has('package.json')) project_type = 'node';
  else if (has('go.mod')) project_type = 'go';
  else if (has('Cargo.toml')) project_type = 'rust';
  else if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) project_type = 'python';
  else if (has('pom.xml') || has('build.gradle')) project_type = 'java';
  else if (has('Gemfile')) project_type = 'ruby';
  else if (has('composer.json')) project_type = 'php';

  const primary_languages = [...langCount.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l);

  const test_files = files.filter(f =>
    /(^|\/)(test|tests|__tests__)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f)
  ).slice(0, MAX_LIST);

  const CONFIG_NAMES = /^(package\.json|package-lock\.json|tsconfig\.json|\.gitignore|\.eslintrc.*|\.prettierrc.*|.*\.config\.(js|ts|mjs|cjs)|dockerfile|docker-compose\.ya?ml|makefile|vite\.config\..*|webpack\.config\..*|go\.mod|cargo\.toml|pyproject\.toml|requirements\.txt)$/i;
  const config_files = files.filter(f => CONFIG_NAMES.test(basename(f))).slice(0, MAX_LIST);

  // ── Signals (bounded content scan — read-only) ──────────────────────────────
  const routes = [];
  const schemas = [];
  const workflows = [];
  const dependencies = [];

  // Dependencies from package.json (names only; never values/scripts secrets).
  if (has('package.json')) {
    try {
      const pkgRaw = readFileSync(join(root, 'package.json'), 'utf8').slice(0, MAX_CONTENT_BYTES);
      const pkg = JSON.parse(pkgRaw);
      for (const k of Object.keys(pkg.dependencies || {})) capPush(dependencies, k);
      for (const k of Object.keys(pkg.devDependencies || {})) capPush(dependencies, k);
    } catch { /* malformed package.json — skip silently */ }
  }

  // GitHub Actions / workflow-named files are workflow signals (path only).
  for (const f of files) {
    if (/(^|\/)\.github\/workflows\//.test(f) || /workflow/i.test(basename(f))) capPush(workflows, f);
  }

  // Route + schema heuristics over a bounded set of text source files.
  let scanned = 0;
  const ROUTE_RE = /\b(?:app|router)\s*\.\s*(get|post|put|patch|delete|use|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const SQL_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([\w.]+)["'`]?/gi;
  for (const f of files) {
    if (scanned >= MAX_CONTENT_SCAN_FILES) { truncated = true; break; }
    if (!TEXT_SCAN_EXT.has(extname(f).toLowerCase())) continue;
    let content;
    try {
      const full = join(root, f);
      if (statSync(full).size > MAX_CONTENT_BYTES) continue;
      content = readFileSync(full, 'utf8');
    } catch { continue; }
    scanned++;
    let m;
    while ((m = ROUTE_RE.exec(content)) !== null) capPush(routes, m[1].toUpperCase() + ' ' + m[2]);
    while ((m = SQL_TABLE_RE.exec(content)) !== null) capPush(schemas, m[1]);
    if (/schema/i.test(basename(f))) capPush(schemas, f + ' (schema-named file)');
  }

  // Entrypoints: package.json main/bin + conventional roots.
  const entrypoints = [];
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').slice(0, MAX_CONTENT_BYTES));
      if (typeof pkg.main === 'string') capPush(entrypoints, pkg.main);
      if (typeof pkg.bin === 'string') capPush(entrypoints, pkg.bin);
      else if (pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) capPush(entrypoints, String(v));
      if (pkg.scripts && typeof pkg.scripts.start === 'string') capPush(entrypoints, 'npm start → ' + pkg.scripts.start);
    } catch { /* skip */ }
  }
  for (const conv of ['server.js', 'index.js', 'app.js', 'main.js', 'main.py', 'index.ts', 'main.go']) {
    if (has(conv)) capPush(entrypoints, conv);
  }

  if (truncated) {
    risks.push({ type: 'analysis_truncated', path: '.', detail: 'analysis bounds reached; listing/scan is partial (safe stop)' });
  }

  return {
    request_id: String(requestId),
    class: 'reverse_engineer',
    analysis_only: true,
    mutation: false,
    terminal: false,
    target: {
      requested_path: reqIn,
      resolved_path: root,
      within_boundary: true,
    },
    summary: {
      project_type,
      primary_languages,
      entrypoints: entrypoints.slice(0, MAX_LIST),
      test_files,
      config_files,
    },
    structure: {
      directories: directories.slice(0, MAX_ENTRIES),
      files: files.slice(0, MAX_ENTRIES),
    },
    signals: {
      routes: routes.slice(0, MAX_LIST),
      schemas: schemas.slice(0, MAX_LIST),
      workflows: workflows.slice(0, MAX_LIST),
      dependencies: dependencies.slice(0, MAX_LIST),
    },
    risks: risks.slice(0, MAX_LIST),
    non_actions: [
      'No files written',
      'No shell executed',
      'No terminal route used',
      'No remotes contacted',
    ],
  };
}
