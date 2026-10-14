// Model links: a printable model in a URL fragment, like a Glass screen link. The fragment never reaches the web
// host, so a public page can open private designs. Data only, never code. Runs in browsers and Node (18+).
//
//   https://<host>/#m=1.<base64url(deflate-raw(JSON))>[&get=stl|3mf]
//   JSON: { title, version, src, set, material, orientation, rules: [[label, value, unit]], q, p, t, parts }
//     p: [x, y, z, …] whole multiples of q (mm); t: [a, b, c, …] triangles as vertex indices, counter-clockwise
//     seen from outside; Z up, the bed at z = 0.
//     parts (optional): [[name, role, label, first, count, slot?]], runs of triangles in t; role "support" is printed,
//     then removed; slot is the part's AMS slot (1 without one). Without parts, the whole model is one part.
//   Or placed shapes, for things made of repeated parts (nine keys): each shape once, then where each copy goes:
//     { …, shapes: [{ role, label, slot?, q, p, t }], place: [[shape, a, b, c, d, e, f, g, h, i, j, k, l, name?]] }
//     (a 3 × 4 transform by rows, in mm). decode() expands them, so the rest of the page sees one model.
// "1." is the format version: newer pages must keep reading old links.

export const VERSION = 1;
export const LIMITS = { vertices: 200000, triangles: 400000, shapes: 512, places: 2048 }; // every keycap with its own legend is its own shape

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

// fromTriangles([[[x,y,z] ×3], …]) -> { q, p, t }: shared corners merged on a grid ~1/5000 of the model's size.
export function fromTriangles(tris) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; // a loop: spreading big models overflows the stack
  for (const tri of tris) for (const v of tri) for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
  const extent = tris.length ? Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0;
  const q = Number((10 ** Math.floor(Math.log10(extent / 5000 || 1))).toPrecision(1));
  const p = [], t = [], index = new Map();
  for (const tri of tris) {
    const ids = tri.map((v) => { const g = v.map((c) => Math.round(c / q)), k = g.join(','); if (!index.has(k)) { index.set(k, p.length / 3); p.push(...g); } return index.get(k); });
    if (ids[0] !== ids[1] && ids[1] !== ids[2] && ids[0] !== ids[2]) t.push(...ids); // snapping can collapse slivers
  }
  return { q, p, t };
}

// fromParts([{ name, role, label, triangles }]) -> { q, p, t, parts }: shared corners merged across parts.
export function fromParts(list) {
  const m = fromTriangles(list.flatMap((x) => x.triangles)), parts = [];
  // fromTriangles drops triangles that snapping collapses, so count each part's survivors in order
  let at = 0, kept = 0;
  const grid = (v) => v.map((c) => Math.round(c / m.q)).join(',');
  for (const x of list) {
    const first = kept;
    for (const tri of x.triangles) { const k = tri.map(grid); if (k[0] !== k[1] && k[1] !== k[2] && k[0] !== k[2]) kept++; at++; }
    parts.push([x.name, x.role || 'part', x.label || x.name, first, kept - first, ...(x.slot > 1 ? [x.slot] : [])]);
  }
  return { ...m, parts };
}

export async function encode(model) {
  const bytes = await pipe(new TextEncoder().encode(JSON.stringify(model)), new CompressionStream('deflate-raw'));
  return `${VERSION}.${b64(bytes)}`;
}

// The model link's parts from a location hash: { token, gist, get }. A short link (#s=<id>) names a GitHub Gist
// holding the token.
export function parseHash(hash) {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  return { token: params.get('m'), gist: params.get('s'), get: params.get('get') };
}

// The token from a short link's Gist (GitHub's API allows this without signing in, about 60 times an hour).
export async function fromGist(id) {
  if (!/^[0-9a-f]{20,40}$/i.test(String(id))) throw new Error("this short link's ID isn't a Gist ID");
  const r = await fetch(`https://api.github.com/gists/${id}`);
  if (r.status === 404) throw new Error('This short link points to a Gist that no longer exists.');
  if (!r.ok) throw new Error(`GitHub didn't send the model (${r.status}). Try again in a minute.`);
  const f = (await r.json()).files?.['model.txt'];
  if (!f) throw new Error('This Gist holds no model.');
  return (f.truncated ? await (await fetch(f.raw_url)).text() : f.content).trim();
}

export async function decode(token) {
  const m = String(token || '').match(/^(\d+)\.([\w-]+)$/);
  if (!m) throw new Error("this isn't a model link");
  if (Number(m[1]) > VERSION) throw new Error(`this link needs a newer page (format ${m[1]})`);
  let model;
  try { model = JSON.parse(new TextDecoder().decode(await pipe(unb64(m[2]), new DecompressionStream('deflate-raw')))); }
  catch { throw new Error('This link is damaged: it may have been cut short when it was shared. Copy the whole link again.'); }
  if (model && Array.isArray(model.shapes)) model = expand(model);
  const errors = check(model);
  if (errors.length) throw new Error(errors[0]);
  return model;
}

export function check(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.p) || !Array.isArray(m.t)) return ['no model in the link'];
  if (!(m.q > 0)) return ['bad grid size'];
  if (m.p.length % 3 || m.t.length % 3) return ['broken model data'];
  if (m.p.length / 3 > LIMITS.vertices || m.t.length / 3 > LIMITS.triangles) return ['model too big for a link'];
  const n = m.p.length / 3;
  if (m.p.some((x) => !Number.isInteger(x)) || m.t.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) return ['broken model data'];
  if (m.parts != null && (!Array.isArray(m.parts) || m.parts.some((x) => !Array.isArray(x) || !Number.isInteger(x[3]) || !Number.isInteger(x[4]) || x[3] < 0 || x[3] + x[4] > m.t.length / 3))) return ['broken parts list'];
  return [];
}

// Placed shapes -> one model ({ q, p, t, parts }), each copy its own part.
export function expand(m) {
  const { shapes, place, ...meta } = m;
  if (!Array.isArray(place) || shapes.length > LIMITS.shapes || place.length > LIMITS.places) throw new Error('model too big for a link');
  for (const sh of shapes) { const e = check(sh); if (e.length) throw new Error(e[0]); }
  const list = place.map(([i, ...rest], n) => {
    const sh = shapes[i], t = rest.slice(0, 12);
    if (!sh || t.length !== 12 || t.some((x) => !Number.isFinite(x))) throw new Error('broken placement');
    const at = ([x, y, z]) => [t[0] * x + t[1] * y + t[2] * z + t[3], t[4] * x + t[5] * y + t[6] * z + t[7], t[8] * x + t[9] * y + t[10] * z + t[11]];
    return { name: rest[12] || `${sh.label || 'shape'} ${n + 1}`, role: sh.role || 'part', label: sh.label || 'shape', slot: sh.slot, triangles: triangles(sh).map((tri) => tri.map(at)) };
  });
  return { ...meta, ...fromParts(list) };
}

// fromShapes(parts) for tools: [{ shape, role, label, triangles (local), matrix: 12 numbers, name }] -> { shapes, place }
export function fromShapes(list) {
  const index = new Map(), shapes = [], place = [];
  for (const x of list) {
    if (!index.has(x.shape)) { index.set(x.shape, shapes.length); shapes.push({ role: x.role, label: x.label, ...(x.slot > 1 ? { slot: x.slot } : {}), ...fromTriangles(x.triangles) }); }
    place.push([index.get(x.shape), ...x.matrix, x.name]);
  }
  return { shapes, place };
}

// Triangles in mm: [[[x,y,z] ×3], …], all of them or one part's ([name, role, label, first, count]).
export function triangles(m, part) {
  const v = (i) => [m.p[3 * i] * m.q, m.p[3 * i + 1] * m.q, m.p[3 * i + 2] * m.q], out = [];
  const [from, to] = part ? [part[3] * 3, (part[3] + part[4]) * 3] : [0, m.t.length];
  for (let i = from; i < to; i += 3) out.push([v(m.t[i]), v(m.t[i + 1]), v(m.t[i + 2])]);
  return out;
}

// The model's parts, always at least one: [[name, role, label, first, count]]
export const partsOf = (m) => (m.parts?.length ? m.parts : [['body', 'part', m.title || 'model', 0, m.t.length / 3]]);

// ---------- files ----------
// cap@0.6.0.stl; with what was picked, if not everything: staggered-cap-2-4.3mf
export const filename = (m, ext, picked = '') => `${[String(m.src || m.title || 'model').split('/').pop(), m.set && m.set.replace(/,/g, '-'), picked].filter(Boolean).join('-').replace(/[^\w@.=-]+/g, '-')}.${ext}`;

// Which parts a file holds: all the printed ones (references are only there to check a fit), or the indices picked
const chosen = (m, keep) => partsOf(m).filter((x, i) => (keep ? keep.has(i) : x[1] !== 'reference'));

// Binary STL (mm): the parts picked, as one mesh, each part mended (mesh) as for 3MF.
export function stl(m, keep) {
  const tris = chosen(m, keep).flatMap((x) => { const { verts, tris: t } = mesh(triangles(m, x)); return t.map((ids) => ids.map((i) => verts[i])); }), buf = new ArrayBuffer(84 + 50 * tris.length), dv = new DataView(buf);
  const head = `mirror-cad ${m.src || m.title || ''}`.slice(0, 80);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i) & 0x7f);
  dv.setUint32(80, tris.length, true);
  tris.forEach(([a, b, c], i) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1; n = n.map((x) => x / l);
    [...n, ...a, ...b, ...c].forEach((x, k) => dv.setFloat32(84 + 50 * i + 4 * k, x, true));
  });
  return new Uint8Array(buf);
}

// The printed thing a part belongs to: key-1-1.cap.legend -> key-1-1.cap, case.body -> case; a single object's parts
// (cap, legend, pillar) are all one thing
export const thingOf = (name) => { const bits = String(name).split('.'); return bits.length > 2 ? bits.slice(0, -1).join('.') : bits.length > 1 ? bits[0] : ''; };

// 3MF of the parts picked, in Bambu Studio's layout (bambu3mf): one object per printed thing, its parts on their AMS
// slots (parts' sixth field; slot 1 without one).
export async function threemf(m, keep) {
  const things = new Map();
  for (const x of chosen(m, keep)) {
    const id = thingOf(x[0]);
    if (!things.has(id)) things.set(id, []);
    things.get(id).push({ name: id ? x[0].split('.').pop() : x[2] || x[0], triangles: triangles(m, x), slot: x[5] || 1 });
  }
  return bambu3mf([...things].map(([id, parts]) => ({ name: id || m.title || 'model', parts })), { title: m.title });
}

// ---------- Bambu Studio's 3MF ----------
// A 3MF in Bambu Studio's own project layout, so it opens as objects made of parts, each part already on its filament
// (AMS slot):
//   3D/3dmodel.model           one object per printed thing (a keycap), its components the parts' meshes
//   3D/Objects/object_N.model  that object's meshes, one per part (cap, legend, breakaway supports)
//   Metadata/model_settings.config   each object's parts with their names and extruder; the objects on plate 1
// Other slicers read the same file as plain objects with components. The layout was copied from a project Bambu Studio
// 01.09 saved itself (BambuStudio --assemble … --export-3mf), and checked by loading ours back the same way: one object
// per keycap, its parts and their filaments come through. The file says it's from mirror-cad, not Bambu Studio: a file
// that claims to be a Bambu project but has no printer settings makes Bambu Studio 01.09 crash. There are no project
// settings in it at all, so opening it never touches your printer, process or filament settings; the parts' AMS slots
// map onto the filaments you have loaded. Used by the CLI's export (lib/threemf.mjs) and the model page alike.
//   await bambu3mf([{ name, parts: [{ name, triangles, slot }] }], { centre }) -> Uint8Array (a zip)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (x) => String(Number(x.toFixed(5)));

// triangles -> { verts, tris }: corners within a micron merged, zero-area triangles (three corners in a line) dropped,
// and the part closed. JSCAD's booleans leave T-junctions (a corner of one face in the middle of a neighbour's edge) and
// lose the odd sliver face, so a part's faces don't join up: Bambu Studio says "manifold = no", splits it into fragments
// and its repair can fill a legend's letters with sheets. So a triangle with a loose corner lying along its open edge is
// split there, one corner at a time until none is left, and any pinhole still open (a loop of open edges less than a
// millimetre round) is closed with a fan. Each part comes out as one closed body per piece (a keycap; each letter).
export function mesh(tris) {
  const MERGE = 1e-3, verts = [], index = new Map(), out = [];
  const key = (v) => v.map((c) => Math.round(c / MERGE)).join(',');
  const at = (v) => { // the same corner as one already seen within MERGE (it may sit across a rounding boundary)
    const g = v.map((c) => Math.round(c / MERGE));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of index.get(`${g[0] + dx},${g[1] + dy},${g[2] + dz}`) || []) if (Math.hypot(verts[i][0] - v[0], verts[i][1] - v[1], verts[i][2] - v[2]) < MERGE) return i;
    }
    const k = key(v); if (!index.has(k)) index.set(k, []); index.get(k).push(verts.length); verts.push(v); return verts.length - 1;
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (u, w) => [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const area2 = (ids) => { const [a, b, c] = ids.map((i) => verts[i]); return Math.hypot(...cross(sub(b, a), sub(c, a))); };
  for (const t of tris) for (let i = 1; i < t.length - 1; i++) { const ids = [at(t[0]), at(t[i]), at(t[i + 1])]; if (new Set(ids).size === 3 && area2(ids) > 1e-9) out.push(ids); }

  // Mend: split a triangle at a loose corner lying along its open edge, one corner at a time, until none is left
  const TOL = 2e-3, CELL = 1, cell = (x) => Math.floor(x / CELL);
  for (let pass = 0; pass < 50; pass++) {
    const edges = new Set(); for (const [a, b, c] of out) edges.add(`${a},${b}`).add(`${b},${c}`).add(`${c},${a}`);
    const isOpen = (a, b) => !edges.has(`${b},${a}`), loose = new Set();
    for (const [a, b, c] of out) for (const [x, y] of [[a, b], [b, c], [c, a]]) if (isOpen(x, y)) loose.add(x).add(y);
    if (!loose.size) break;
    const grid = new Map();
    for (const i of loose) { const k = verts[i].map(cell).join(','); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
    // The loose corner along a -> b nearest the line, if any
    const along = (a, b) => {
      const p = verts[a], d = sub(verts[b], p), len = Math.sqrt(dot(d, d));
      const lo = [0, 1, 2].map((k) => cell(Math.min(p[k], verts[b][k]) - TOL)), hi = [0, 1, 2].map((k) => cell(Math.max(p[k], verts[b][k]) + TOL));
      let best = null;
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        for (const i of grid.get(`${x},${y},${z}`) || []) {
          if (i === a || i === b) continue;
          const w = sub(verts[i], p), t = dot(w, d) / (len * len);
          if (t * len < TOL || (1 - t) * len < TOL) continue;
          const off = Math.hypot(...cross(w, d)) / len;
          if (off < TOL && (!best || off < best[1])) best = [i, off];
        }
      }
      return best;
    };
    let split = 0;
    const n = out.length;
    for (let k = 0; k < n; k++) {
      const t = out[k];
      let pick = null;
      for (let e = 0; e < 3; e++) {
        const a = t[e], b = t[(e + 1) % 3];
        if (!isOpen(a, b)) continue;
        const f = along(a, b);
        if (f && (!pick || f[1] < pick[1])) pick = [f[0], f[1], e];
      }
      if (!pick) continue;
      const [v, , e] = pick, a = t[e], b = t[(e + 1) % 3], c = t[(e + 2) % 3];
      out[k] = [a, v, c]; out.push([v, b, c]); split++;
    }
    if (!split) break;
  }
  // What's left are pinholes: a sliver face the booleans lost, a loop of open edges a fraction of a millimetre round.
  // Close each with a fan.
  const kept = out.filter((ids) => area2(ids) > 1e-9), edges = new Set();
  for (const [a, b, c] of kept) edges.add(`${a},${b}`).add(`${b},${c}`).add(`${c},${a}`);
  const next = new Map();
  for (const k of edges) { const [a, b] = k.split(',').map(Number); if (!edges.has(`${b},${a}`)) next.set(a, b); }
  const PINHOLE = 1;
  for (const start of [...next.keys()]) {
    if (!next.has(start)) continue;
    const loop = [start];
    for (let v = next.get(start); v !== start && v != null && loop.length < 64; v = next.get(v)) loop.push(v);
    if (next.get(loop[loop.length - 1]) !== start) continue;
    const round = loop.reduce((sum, v, i) => sum + Math.hypot(...sub(verts[loop[(i + 1) % loop.length]], verts[v])), 0);
    if (round > PINHOLE) continue;
    for (let i = 1; i < loop.length - 1; i++) kept.push([loop[0], loop[i + 1], loop[i]]);
    for (const v of loop) next.delete(v);
  }
  return { verts, tris: kept };
}

const meshXml = ({ verts, tris }) => `<mesh><vertices>${verts.map((v) => `<vertex x="${num(v[0])}" y="${num(v[1])}" z="${num(v[2])}"/>`).join('')}</vertices>`
  + `<triangles>${tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh>`;

const uuid = (n, kind) => `${kind.toString(16).padStart(4, '0')}${(n & 0xffff).toString(16).padStart(4, '0')}-81cb-4c03-9d28-80fed5dfa1dc`;
const IDENTITY = '1 0 0 0 1 0 0 0 1 0 0 0', IDENTITY4 = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';

export async function bambu3mf(objects, { centre = [128, 128] } = {}) {
  const files = {}, rels = [], resources = [], build = [], settings = [], instances = [];
  let id = 0;
  objects.forEach((o, n) => {
    const path = `/3D/Objects/object_${n + 1}.model`, parts = o.parts.map((p) => ({ ...p, id: ++id }));
    files[path.slice(1)] = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ${NS}>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n`
      + parts.map((p) => `  <object id="${p.id}" p:UUID="${uuid(p.id, 1)}" type="model">${meshXml(mesh(p.triangles))}</object>\n`).join('') + ' </resources>\n <build/>\n</model>\n';
    rels.push(`<Relationship Target="${path}" Id="rel-${n + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`);
    const parent = 100000 + n + 1;
    resources.push(`  <object id="${parent}" p:UUID="${uuid(n + 1, 0)}" type="model">\n   <components>\n`
      + parts.map((p) => `    <component p:path="${path}" objectid="${p.id}" p:UUID="${uuid(p.id, 2)}" transform="${IDENTITY}"/>\n`).join('') + '   </components>\n  </object>\n');
    build.push(`  <item objectid="${parent}" p:UUID="${uuid(n + 1, 3)}" transform="1 0 0 0 1 0 0 0 1 ${centre[0]} ${centre[1]} 0" printable="1"/>\n`);
    settings.push(`  <object id="${parent}">\n    <metadata key="name" value="${esc(o.name)}"/>\n    <metadata key="extruder" value="${parts[0]?.slot || 1}"/>\n`
      + parts.map((p) => `    <part id="${p.id}" subtype="normal_part">\n      <metadata key="name" value="${esc(p.name)}"/>\n      <metadata key="matrix" value="${IDENTITY4}"/>\n      <metadata key="extruder" value="${p.slot || 1}"/>\n    </part>\n`).join('') + '  </object>\n');
    instances.push(`    <model_instance>\n      <metadata key="object_id" value="${parent}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${n + 1}"/>\n    </model_instance>\n`);
  });
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n', today = new Date().toISOString().slice(0, 10);
  return zip([
    ['[Content_Types].xml', `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>\n`],
    ['_rels/.rels', `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n`],
    ['3D/_rels/3dmodel.model.rels', `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n ${rels.join('\n ')}\n</Relationships>\n`],
    ['3D/3dmodel.model', `${xml}<model unit="millimeter" xml:lang="en-US" ${NS}>\n <metadata name="Application">mirror-cad</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <metadata name="Title">mirror-cad</metadata>\n <metadata name="CreationDate">${today}</metadata>\n <resources>\n${resources.join('')} </resources>\n <build p:UUID="${uuid(0, 4)}">\n${build.join('')} </build>\n</model>\n`],
    ['Metadata/model_settings.config', `${xml}<config>\n${settings.join('')}  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n${instances.join('')}  </plate>\n</config>\n`],
    ...Object.entries(files),
  ]);
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// A ZIP, each file deflated with the browser's (or Node's) own CompressionStream: no library needed.
async function zip(entries) {
  const enc = new TextEncoder(), parts = [], dir = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = enc.encode(name), raw = enc.encode(text), crc = crc32(raw), d = await pipe(raw, new CompressionStream('deflate-raw'));
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [8, 8, 2], [14, crc, 4], [18, d.length, 4], [22, raw.length, 4], [26, n.length, 2]].forEach(([o, v, s]) => (s === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
    const central = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [10, 8, 2], [16, crc, 4], [20, d.length, 4], [24, raw.length, 4], [28, n.length, 2], [42, offset, 4]].forEach(([o, v, s]) => (s === 4 ? central.setUint32(o, v, true) : central.setUint16(o, v, true)));
    parts.push(new Uint8Array(local.buffer), n, d);
    dir.push(new Uint8Array(central.buffer), n);
    offset += 30 + n.length + d.length;
  }
  const size = dir.reduce((s, b) => s + b.length, 0), end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [8, entries.length, 2], [10, entries.length, 2], [12, size, 4], [16, offset, 4]].forEach(([o, v, s]) => (s === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
  const all = [...parts, ...dir, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const b of all) { out.set(b, at); at += b.length; }
  return out;
}
