// Reprise dans un bâtiment (src/reprise-batiment.js) : où la partie reprend, et la ligne du menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingResume, savedLine, RESUME_MAX_M } from '../src/reprise-batiment.js';

// Repère local : 1 degré de latitude = 111 000 m, de longitude = 78 000 m (à peu près 45° N), origine 45,000 N 5,000 E.
const toLocal = (lat, lon) => ({ x: (lon - 5) * 78000, z: (lat - 45) * 111000 });
const door = { x: 0, z: 0 };
const w = (more = {}) => ({ lat: 45.001, lon: 5.001, at: 1, inside: false, in: 'b45.001_5.001', ...more });

test('buildingResume : un bâtiment gardé, près de la porte du refuge, donne le point de reprise dans le monde chargé', () => {
  const r = buildingResume(w(), toLocal, door);
  assert.equal(r.id, 'b45.001_5.001');
  assert.ok(Math.abs(r.x - 78) < 1e-6 && Math.abs(r.z - 111) < 1e-6);
  assert.deepEqual(buildingResume(w(), toLocal), r, 'sans porte de référence, aucune limite de distance');
});

test('buildingResume : rien à reprendre dehors, au refuge, sans bâtiment, ou loin du refuge', () => {
  assert.equal(buildingResume(null, toLocal, door), null);
  assert.equal(buildingResume(w({ in: undefined }), toLocal, door), null, 'quitté dehors : la reprise reste celle de la porte');
  assert.equal(buildingResume(w({ in: '' }), toLocal, door), null);
  assert.equal(buildingResume(w({ in: 5 }), toLocal, door), null);
  assert.equal(buildingResume(w({ inside: true }), toLocal, door), null, 'quitté dans le refuge : la porte, dedans');
  assert.equal(buildingResume(w({ lat: NaN }), toLocal, door), null);
  assert.equal(buildingResume(w({ lon: 'x' }), toLocal, door), null);
  // 2 km au nord : au-delà du monde chargé autour du refuge.
  assert.equal(buildingResume(w({ lat: 45.018 }), toLocal, door), null);
  assert.ok(RESUME_MAX_M >= 1000 && RESUME_MAX_M <= 2000);
  assert.equal(buildingResume(w(), () => ({ x: NaN, z: 0 }), door), null);
  assert.equal(buildingResume(w(), () => null, door), null);
});

test('savedLine : l\'heure de la sauvegarde, et la reprise dans un bâtiment seulement quand la partie y reprendra', () => {
  const at = new Date(2026, 9, 18, 14, 5).getTime();
  assert.equal(savedLine(at, false), 'Partie sauvegardée à 14 h 05.');
  assert.equal(savedLine(at, true), 'Partie sauvegardée à 14 h 05. Tu reprends dans le bâtiment où tu as quitté.');
});
