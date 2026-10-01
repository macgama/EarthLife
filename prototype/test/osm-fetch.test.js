import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOsm } from '../src/osm.js';

function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url).host);
    const r = responses.shift();
    return new Response(r.body ?? '', { status: r.status ?? 200 });
  };
  return calls;
}

const servers = ['https://a.test/api/interpreter', 'https://b.test/api/interpreter'];
const ok = JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 0, lon: 0 }] });

test('passe au serveur suivant quand Overpass est saturé (429)', async () => {
  const calls = mockFetch([{ status: 429 }, { body: ok }]);
  const osm = await fetchOsm(45.76, 4.83, 700, { servers });
  assert.equal(osm.elements.length, 1);
  assert.deepEqual(calls, ['a.test', 'b.test']);
});

test("n'insiste pas quand la zone est vide", async () => {
  const calls = mockFetch([{ body: JSON.stringify({ elements: [] }) }]);
  await assert.rejects(fetchOsm(0, -30, 700, { servers }), /Aucune donnée/);
  assert.deepEqual(calls, ['a.test']);
});

test("réessaie si un serveur expire (remark sans données)", async () => {
  const calls = mockFetch([{ body: JSON.stringify({ elements: [], remark: 'runtime error: Query timed out' }) }, { body: ok }]);
  const osm = await fetchOsm(45.76, 4.83, 700, { servers });
  assert.equal(osm.elements.length, 1);
  assert.deepEqual(calls, ['a.test', 'b.test']);
});
