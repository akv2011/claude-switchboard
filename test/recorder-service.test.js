import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemdUnits } from '../src/recorder/launchd.js';

test('on Linux the recorder is a one-shot service run by a timer every 30 s', () => {
  const { service, timer } = buildSystemdUnits({ nodePath: '/usr/bin/node', entry: '/home/you/.claude-switchboard/recorder/src/recorder/daemon.js' });
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/home\/you\/\.claude-switchboard\/recorder\/src\/recorder\/daemon\.js --once$/m);
  assert.match(timer, /^OnUnitActiveSec=30$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});
