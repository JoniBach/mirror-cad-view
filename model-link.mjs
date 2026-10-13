// Model links: a printable model in a URL fragment, like a Glass screen link. The fragment never reaches the web
// host, so a public page can open private designs. Data only, never code. Runs in browsers and Node (18+).
//
//   https://<host>/#m=1.<base64url(deflate-raw(JSON))>[&get=stl|3mf]
//   JSON: { title, version, src, set, material, orientation, rules: [[label, value, unit]], q, p, t, parts }
//     p: [x, y, z, …] whole multiples of q (mm); t: [a, b, c, …] triangles as vertex indices, counter-clockwise
//     seen from outside; Z up, the bed at z = 0.
//     parts (optional): [[name, role, label, first, count]], runs of triangles in t; role "support" is printed, then
//     removed. Without parts, the whole model is one part.
//   Or placed shapes, for things made of repeated parts (nine keys): each shape once, then where each copy goes:
//     { …, shapes: [{ role, label, q, p, t }], place: [[shape, a, b, c, d, e, f, g, h, i, j, k, l, name?]] }
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
    parts.push([x.name, x.role || 'part', x.label || x.name, first, kept - first]);
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
    return { name: rest[12] || `${sh.label || 'shape'} ${n + 1}`, role: sh.role || 'part', label: sh.label || 'shape', triangles: triangles(sh).map((tri) => tri.map(at)) };
  });
  return { ...meta, ...fromParts(list) };
}

// fromShapes(parts) for tools: [{ shape, role, label, triangles (local), matrix: 12 numbers, name }] -> { shapes, place }
export function fromShapes(list) {
  const index = new Map(), shapes = [], place = [];
  for (const x of list) {
    if (!index.has(x.shape)) { index.set(x.shape, shapes.length); shapes.push({ role: x.role, label: x.label, ...fromTriangles(x.triangles) }); }
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
export const filename = (m, ext) => `${String(m.src || m.title || 'model').split('/').pop().replace(/[^\w@.=-]+/g, '-')}${m.set ? `-${m.set.replace(/,/g, '-')}` : ''}.${ext}`;

// Binary STL (mm).
export function stl(m) {
  const tris = triangles(m), buf = new ArrayBuffer(84 + 50 * tris.length), dv = new DataView(buf);
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

// 3MF: the 3D model XML in a ZIP (stored, no compression: no library needed).
export function threemf(m) {
  // One object per part (a support shows as its own object in the slicer), each with the vertices it uses
  const objects = partsOf(m).map(([name, , label, first, count], n) => {
    const remap = new Map(), verts = [], tris = [];
    const id = (i) => { if (!remap.has(i)) { remap.set(i, remap.size); verts.push(`<vertex x="${+(m.p[3 * i] * m.q).toFixed(4)}" y="${+(m.p[3 * i + 1] * m.q).toFixed(4)}" z="${+(m.p[3 * i + 2] * m.q).toFixed(4)}"/>`); } return remap.get(i); };
    for (let k = first * 3; k < (first + count) * 3; k += 3) tris.push(`<triangle v1="${id(m.t[k])}" v2="${id(m.t[k + 1])}" v3="${id(m.t[k + 2])}"/>`);
    return { id: n + 1, name: label || name, verts, tris };
  });
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${esc(m.title || '')} ${esc(m.version || '')}</metadata>
<metadata name="Designer">mirror-cad</metadata>
<metadata name="Description">${esc(m.src || '')}${m.set ? ` (${esc(m.set)})` : ''}</metadata>
<resources>${objects.map((o) => `<object id="${o.id}" type="model" name="${esc(o.name)}"><mesh><vertices>${o.verts.join('')}</vertices><triangles>${o.tris.join('')}</triangles></mesh></object>`).join('')}</resources>
<build>${objects.map((o) => `<item objectid="${o.id}"/>`).join('')}</build>
</model>`;
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
    ['3D/3dmodel.model', model],
  ]);
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zip(entries) {
  const enc = new TextEncoder(), parts = [], dir = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = enc.encode(name), d = enc.encode(text), crc = crc32(d);
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [8, 0, 2], [14, crc, 4], [18, d.length, 4], [22, d.length, 4], [26, n.length, 2]].forEach(([o, v, s]) => (s === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
    const central = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [16, crc, 4], [20, d.length, 4], [24, d.length, 4], [28, n.length, 2], [42, offset, 4]].forEach(([o, v, s]) => (s === 4 ? central.setUint32(o, v, true) : central.setUint16(o, v, true)));
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
