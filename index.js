const program = require('commander');
const fs = require('fs-extra');
const path = require('path');
const {spawn} = require('child_process');
const Promise = require('bluebird');
const debug = require('debug');

const log = {
  error: debug('branch-updater:err'),
  info: debug('branch-updater:info'),
};

function spawnPromise(program2, args, options, extra = {}) {

  let display = `Running ${program2} ${args.join(' ')}`;
  if (extra.dry) {
    display += ' (not really)';
    log.info(display);
    return true;
  }

  log.info(display);
  return new Promise((resolve, reject) => {

    const data = [];
    const err = [];
    const ps = spawn(program2, args, options);
    ps.stdout.on('data', (newData) => {
      data.push(newData);
    });

    ps.stderr.on('data', (newData) => {
      err.push(newData);
    });

    ps.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${display}: ${err.join('').substr(-200)} ${data.join('').substr(-200)}`));
        return;
      }
      resolve(data.join(''));
    });
  });
}

program
  .version('0.1.0')
  .option('-p, --path <path>', 'Git path for your repo')
  .option('-d, --dry', 'Do everything except pushing to repo')
  .parse(process.argv);

// console.log(JSON.stringify(program, null, 3));
const TMPDIR = 'tmp';
const TMPDATADIR = `${TMPDIR}/repo`;
const TMPGITDIR = `${TMPDATADIR}/.git`;
const checkGitPath = path.join(program.path, '.git');

function pullMeAndThenJustPushMe() {
  return fs.remove(TMPDIR)
    .then(() => fs.ensureDir(TMPGITDIR))
    .then(() => fs.pathExists(program.path))
    .then((exists) => {
      if (!exists) {
        throw new Error(`Path ${program.path} does not exist!`);
      }
    })
    .then(() => fs.pathExists(checkGitPath))
    .then((exists) => {
      if (!exists) {
        throw new Error(`${checkGitPath} is not a git repo!`);
      }
    })
    .then(() => fs.copy(checkGitPath, TMPGITDIR))
    .then(() => {
      log.info(`Copied ${checkGitPath} to ${TMPGITDIR}, fetching data`);
      return spawnPromise('git', ['fetch', '--all'], {cwd: TMPGITDIR})
        .then(() => {
          const remotes = spawnPromise('git', ['ls-remote', '--heads', 'origin'], {cwd: TMPGITDIR});
          const merged = spawnPromise('git', ['branch', '--merged'], {cwd: TMPGITDIR})
            .then(data => data
              .split('\n')
              .map((item => item.trim()))
              .filter((item => !!item)));
          return Promise.all([remotes, merged]);
        });
    })
    .then(([remotes, merged]) => {
      log.info('Data fetched, filtering');
      return remotes
        .split('\n')
        .map(line => line.split('refs/heads/')[1])
        .filter(branchName => branchName && !branchName.includes('release') && !merged.includes(branchName));
    })
    .then((branches) => {
      log.info('pulling master to master...');
      return spawnPromise('git', ['checkout', '-f', 'master'], {cwd: TMPDATADIR})
        .then(() => spawnPromise('git', ['pull', 'origin', 'master'], {cwd: TMPDATADIR}))
        .then(() => branches);
    })
    .then((branches) => {
      log.info('Pulling master to remote branches...');
      const branchesMasterConflict = [];

      return spawnPromise('git', ['reset', '--hard', 'HEAD'], {cwd: TMPDATADIR})
        .then(() => Promise.map(branches, (branch) => {
          return spawnPromise('git', ['checkout', '-f', branch], {cwd: TMPDATADIR})
            .then(() => spawnPromise('git', ['pull', '.', 'master'], {cwd: TMPDATADIR}))
            .catch((err) => {
              log.error(`Error: ${err}`);
              branchesMasterConflict.push(branch);
              return false;
              // return spawnPromise('git', ['checkout', '-f', branch], {cwd: TMPDATADIR});
            });
        }, {concurrency: 1})
          .then(() => [branches, branchesMasterConflict]));
    })
    .then(([branches, branchesMasterConflict]) => {
      log.info(`${branchesMasterConflict.length}/${branches.length} branches in conflict with master:`);
      log.info(`${branchesMasterConflict.join('\n')}`);
      const noConflict = branches.filter(branch => !branchesMasterConflict.includes(branch));
      const sorted = branchesMasterConflict.sort();
      return fs.writeFile(`${TMPDIR}/master_conflicts.json`, JSON.stringify(sorted, null, 3))
        .then(() => noConflict);
    })
    .then((branches) => {
      log.info('Pushing back all branches without conflict with master');
      return Promise.map(branches, (branch) => {
        return spawnPromise('git', ['checkout', '-f', branch], {cwd: TMPDATADIR})
          .then(() => {
            return spawnPromise('git', ['push', 'origin', branch], {cwd: TMPDATADIR}, {dry: program.dry});
          })
          .catch((err)=>{
            log.error(`Push error: ${err}`);
          });
      }, {concurrency: 1});
    })
    .then(() => {
      log.info('Pushed everything we could!');
    })
    .catch((err) => {
      log.error(err);
    });
}


pullMeAndThenJustPushMe();
