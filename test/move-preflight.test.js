import test from 'node:test';
import assert from 'node:assert/strict';
import { movePreflight } from '../src/core/api.js';
import { openBackgroundTasks } from '../src/core/autobalance.js';

const config = { host: 'devbox', label: 'Devbox', projectsRoot: '~/Projects', localProjectsRoot: '/Users/you/Projects' };
const remote = { reachable: true, sessions: [], tmux: [], home: '/home/you' };
const scanned = { sessionId: 'f1d70e3b-0000-4000-8000-000000000001', name: 'Shop_REA', cwd: '/Users/you/Projects/shop' };

test('a move picked by hand is refused only for background tasks it would stop', () => {
  assert.equal(movePreflight({ scanned, remote, config, tasks: '2 background tasks still running' }),
    'it has 2 background tasks still running, and moving it would stop them');
  assert.equal(movePreflight({ scanned, remote, config }), null, 'a chat that lately used git or a Chrome profile still goes');
});

test('background tasks still running are counted from their start and completion lines', () => {
  const line = (type, text, timestamp = '2026-10-17T19:00:00.000Z') => JSON.stringify({ type, timestamp, message: { content: [{ type: 'tool_result', content: text }] } });
  const shell = line('user', 'Command running in background with ID: bnzxxc02n. Output is being written to x');
  const agent = line('user', 'Async agent launched successfully. agentId: a1b2c3');
  const done = (id) => line('user', `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>`);
  assert.equal(openBackgroundTasks([shell, agent].join('\n')), 2);
  assert.equal(openBackgroundTasks([shell, agent, done('a1b2c3')].join('\n')), 1);
  assert.equal(openBackgroundTasks([shell, done('bnzxxc02n')].join('\n')), 0);
  assert.equal(openBackgroundTasks(line('user', 'Monitor started (task byihn56o9, expires in 30m)')), 0, 'monitors expire on their own');
  assert.equal(openBackgroundTasks(line('assistant', 'Command running in background with ID: quoted1')), 0, "a chat's own words start nothing");
  assert.equal(openBackgroundTasks(line('user', 'test.js: const shell = \'Command running in background with ID: quoted2\'')), 0,
    'a tool result that only quotes the marker starts nothing');
  assert.equal(openBackgroundTasks(shell, Date.parse('2026-10-17T20:00:00Z')), 0, 'a task from before the chat restarted died with it');
});
