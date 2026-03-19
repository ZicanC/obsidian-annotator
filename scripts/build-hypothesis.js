const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const submoduleDir = path.join(rootDir, 'submodules', 'hypothesis-client-annotator-fork');
const submoduleBuildDir = path.join(submoduleDir, 'build');
const vendoredBuildDir = path.join(rootDir, 'resources', 'cdn.hypothes.is', 'hypothesis', 'build');

function hasFile(targetPath) {
  return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile();
}

function hasDirectory(targetPath) {
  return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
}

function hasVendoredBuild() {
  return hasFile(path.join(vendoredBuildDir, 'manifest.json'));
}

function hasInitializedSubmodule() {
  return hasDirectory(submoduleDir) && hasFile(path.join(submoduleDir, 'package.json'));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function moveBuildOutput() {
  fs.rmSync(vendoredBuildDir, {recursive: true, force: true});
  fs.mkdirSync(path.dirname(vendoredBuildDir), {recursive: true});
  fs.renameSync(submoduleBuildDir, vendoredBuildDir);
}

if (!hasInitializedSubmodule()) {
  if (hasVendoredBuild()) {
    console.log(
      '[build-hypothesis] Hypothesis submodule is not initialized; reusing vendored assets in resources/cdn.hypothes.is/hypothesis/build.'
    );
    process.exit(0);
  }

  console.error(
    '[build-hypothesis] Missing submodule at submodules/hypothesis-client-annotator-fork and no vendored build output found.'
  );
  console.error('[build-hypothesis] Run `git submodule update --init --recursive` or restore the vendored resources.');
  process.exit(1);
}

if (process.platform === 'win32') {
  run('npm', ['install', '--force'], submoduleDir);
  run('npm', ['run', 'build'], submoduleDir);
} else {
  run('make', ['build'], submoduleDir);
}

if (!hasDirectory(submoduleBuildDir)) {
  console.error(`[build-hypothesis] Expected build output at ${submoduleBuildDir}, but it was not created.`);
  process.exit(1);
}

moveBuildOutput();
