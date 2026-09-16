/**
 * plane-mcp — MCP bridge to a self-hosted Plane (Community Edition).
 *
 * Forked from the vikunja-mcp bridge (edkog/vik): the transport, multi-principal
 * auth, markdown conversion and response-shaping are the same proven pieces. What
 * changed is everything that touches the tracker, because Plane's API is a
 * different shape: UUIDs instead of integers, states instead of kanban buckets,
 * description_html instead of description, and an X-API-Key header.
 *
 * Transport: streamable HTTP (single JSON responses), bearer auth.
 * Zero dependencies beyond `marked`.
 *
 * IMPORTANT, read before trusting anything below: this was written against
 * Plane's published API reference, NOT against a running instance. Endpoint paths
 * and field names are documented; response ENVELOPES are not reliably documented,
 * so every list response is unwrapped defensively and `check_api` reports the
 * shapes it actually saw. Run check_api first on a new instance and fix anything
 * it flags before doing bulk work.
 */

import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { marked } from "marked";

marked.use({ gfm: true, breaks: false });

function mdToHtml(src, format) {
  if (src === undefined || src === null) return undefined;
  if (format === "html") return String(src);
  return marked.parse(String(src));
}

/* ------------------------------ config ------------------------------ */
const PLANE_API_URL = (process.env.PLANE_API_URL ?? "http://api:8000").replace(/\/$/, "");
const WORKSPACE = process.env.PLANE_WORKSPACE_SLUG ?? "";
const PLANE_TOKEN = process.env.PLANE_TOKEN ?? "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const PORT = Number(process.env.MCP_PORT ?? 8790);
const BLOCK_DONE = (process.env.MCP_BLOCK_DONE ?? "true") === "true";
// Plane's personal access tokens are NOT scoped per route the way Vikunja's are,
// so "this token cannot delete anything" has to be enforced here instead. Every
// outbound DELETE is refused unless this is explicitly turned on.
const ALLOW_DELETE = (process.env.MCP_ALLOW_DELETE ?? "false") === "true";
const FETCH_ALLOW_HOSTS = (process.env.MCP_FETCH_ALLOW_HOSTS ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const PAGE_MAX = 100;

if (!WORKSPACE) {
  console.error("PLANE_WORKSPACE_SLUG is required (the slug in /api/v1/workspaces/<slug>/...).");
  process.exit(1);
}

/* --------------------------- principals ---------------------------- */
// One bridge, several people: each caller's MCP bearer token maps to their own
// Plane API key, so everyone acts as themselves and revoking one person is an
// env-var edit. Identical to the Vikunja bridge; see that repo's README.
function parsePrincipals() {
  const out = [];
  if (MCP_AUTH_TOKEN && PLANE_TOKEN) {
    out.push({ name: "owner", auth: MCP_AUTH_TOKEN, plane: PLANE_TOKEN });
  }
  const raw = (process.env.MCP_PRINCIPALS ?? "").trim();
  if (raw) {
    for (const chunk of raw.split(";")) {
      const entry = chunk.trim();
      if (!entry) continue;
      const parts = entry.split(":").map((s) => s.trim());
      if (parts.length !== 3) {
        console.error(`MCP_PRINCIPALS entry needs 3 colon-separated fields, got ${parts.length}: "${entry.slice(0, 20)}..."`);
        process.exit(1);
      }
      if (parts.some((p) => !p)) {
        console.error(`MCP_PRINCIPALS entry has a blank field: "${entry.slice(0, 20)}..."`);
        process.exit(1);
      }
      const [name, auth, plane] = parts;
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        console.error(`MCP_PRINCIPALS name must be [A-Za-z0-9_-]: "${name}"`);
        process.exit(1);
      }
      out.push({ name, auth, plane });
    }
  }
  if (out.length === 0) {
    console.error("No principals configured. Set MCP_AUTH_TOKEN + PLANE_TOKEN, or MCP_PRINCIPALS.");
    process.exit(1);
  }
  const names = new Set(), auths = new Set();
  for (const p of out) {
    if (names.has(p.name)) { console.error(`Duplicate principal name: ${p.name}`); process.exit(1); }
    if (auths.has(p.auth)) { console.error(`Two principals share an MCP token: ${p.name}`); process.exit(1); }
    names.add(p.name); auths.add(p.auth);
  }
  return out;
}
const PRINCIPALS = parsePrincipals();
const callerCtx = new AsyncLocalStorage();
function currentPrincipal() {
  const p = callerCtx.getStore();
  if (!p) throw new Error("No caller context — a Plane call was made outside a request.");
  return p;
}

/* --------------------------- Plane API ----------------------------- */
// Paths are documented; the response envelope is not, which is why unwrap()
// exists. Everything is scoped to one workspace slug.
const W = () => `/api/v1/workspaces/${WORKSPACE}`;
const EP = {
  projects: () => `${W()}/projects/`,
  workItems: (pid) => `${W()}/projects/${pid}/work-items/`,
  workItem: (pid, id) => `${W()}/projects/${pid}/work-items/${id}/`,
  states: (pid) => `${W()}/projects/${pid}/states/`,
  labels: (pid) => `${W()}/projects/${pid}/labels/`,
  comments: (pid, id) => `${W()}/projects/${pid}/work-items/${id}/comments/`,
  members: (pid) => `${W()}/projects/${pid}/members/`,
  links: (pid, id) => `${W()}/projects/${pid}/work-items/${id}/links/`,
};

// Plane paginates list endpoints, and the exact envelope has varied between
// releases. Accept an array, {results}, or {items}; report which was seen so a
// wrong guess surfaces in check_api instead of as a silent empty list.
function unwrap(data) {
  if (Array.isArray(data)) return { rows: data, envelope: "array" };
  if (data && Array.isArray(data.results)) return { rows: data.results, envelope: "results", count: data.count, next: data.next_cursor ?? data.next ?? null };
  if (data && Array.isArray(data.items)) return { rows: data.items, envelope: "items", count: data.count };
  if (data && typeof data === "object") return { rows: [], envelope: `object(${Object.keys(data).slice(0, 6).join(",")})` };
  return { rows: [], envelope: typeof data };
}

async function plane(path, { method = "GET", body, query } = {}) {
  if (method === "DELETE" && !ALLOW_DELETE) {
    throw new Error(
      "Refused: this bridge does not delete. Plane's API tokens cannot be scoped per route, " +
      "so the no-delete rule is enforced here instead. Delete by hand in the UI, or set " +
      "MCP_ALLOW_DELETE=true deliberately and redeploy."
    );
  }
  const url = new URL(PLANE_API_URL + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: { "X-API-Key": currentPrincipal().plane, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status === 429) {
    throw new Error(
      `Plane ${method} ${path} -> 429 rate limited. API keys default to 60 requests/minute ` +
      `(API_KEY_RATE_LIMIT). Raise it for a bulk run and put it back afterwards.`
    );
  }
  if (!res.ok) {
    const msg = data && typeof data === "object"
      ? (data.detail ?? data.error ?? JSON.stringify(data).slice(0, 300))
      : String(text).slice(0, 300);
    throw new Error(`Plane ${method} ${path} -> ${res.status}: ${msg}`);
  }
  return data;
}

async function planeList(path, query) {
  return unwrap(await plane(path, { query }));
}

/* --------------------------- resolvers ----------------------------- */
// Plane identifies states, labels and people by UUID; humans say names. These
// resolve per project and fail with the valid options rather than passing a bad
// id through to an opaque 400.
const cache = new Map(); // `${principal}:${kind}:${pid}` -> rows
async function rows(kind, pid, path) {
  const key = `${currentPrincipal().name}:${kind}:${pid}`;
  if (!cache.has(key)) cache.set(key, (await planeList(path)).rows);
  return cache.get(key);
}
const invalidate = (pid) => {
  for (const k of [...cache.keys()]) if (k.endsWith(`:${pid}`)) cache.delete(k);
};

const statesOf = (pid) => rows("states", pid, EP.states(pid));
const labelsOf = (pid) => rows("labels", pid, EP.labels(pid));
const membersOf = (pid) => rows("members", pid, EP.members(pid));

async function resolveState(pid, nameOrId) {
  const list = await statesOf(pid);
  const want = String(nameOrId).trim().toLowerCase();
  const hit = list.find((s) => s.id === nameOrId) ?? list.find((s) => String(s.name).toLowerCase() === want);
  if (!hit) throw new Error(`No state "${nameOrId}" on this project. States: ${list.map((s) => s.name).join(", ") || "(none)"}`);
  return hit;
}

async function resolveLabels(pid, names) {
  const list = await labelsOf(pid);
  const byName = new Map(list.map((l) => [String(l.name).toLowerCase(), l]));
  const byId = new Map(list.map((l) => [l.id, l]));
  const found = [], missing = [];
  for (const n of names) {
    const hit = byId.get(n) ?? byName.get(String(n).trim().toLowerCase());
    if (hit) { if (!found.some((f) => f.id === hit.id)) found.push(hit); }
    else missing.push(String(n));
  }
  return { found, missing, all: list };
}

// Plane's project members endpoint nests the user, and the exact nesting has
// moved between releases. Flatten defensively rather than assuming one shape.
const flatMember = (m) => {
  const u = m?.member ?? m?.user ?? m;
  return {
    id: u?.id ?? m?.member_id ?? m?.id,
    display_name: u?.display_name ?? u?.username ?? null,
    email: u?.email ?? null,
    role: m?.role ?? null,
  };
};

async function resolveMembers(pid, people) {
  const list = (await membersOf(pid)).map(flatMember);
  const picked = [], unknown = [];
  for (const raw of people) {
    const want = String(raw).trim().toLowerCase();
    const hit = list.find((u) => u.id === raw)
      ?? list.find((u) => String(u.display_name ?? "").toLowerCase() === want)
      ?? list.find((u) => String(u.email ?? "").toLowerCase() === want);
    if (!hit) { unknown.push(String(raw)); continue; }
    if (!picked.some((p) => p.id === hit.id)) picked.push(hit);
  }
  if (unknown.length) {
    throw new Error(
      `Not a member of this project: ${unknown.join(", ")}. ` +
      `Members: ${list.map((u) => u.display_name ?? u.email ?? u.id).join(", ") || "(none)"}`
    );
  }
  return picked;
}

/* --------------------------- shaping ------------------------------- */
const strip = (s) => String(s ?? "").replace(/<[^>]*>/g, "").trim();

// The read shape. descriptionChars: 0 means no limit; only listings truncate, and
// a cut body is FLAGGED rather than silently shortened — a bridge that quietly
// truncates is how a description gets edited from a partial view.
function slim(t, { descriptionChars = 0, stateName, labelNames, assigneeNames } = {}) {
  if (!t || typeof t !== "object") return t;
  const full = strip(t.description_stripped ?? t.description_html ?? "");
  const cut = descriptionChars > 0 && full.length > descriptionChars;
  return {
    id: t.id,
    sequence_id: t.sequence_id,
    name: t.name,
    ...(cut ? { description_truncated: true, description_full_chars: full.length } : {}),
    description: cut ? full.slice(0, descriptionChars) : full,
    state: stateName ?? t.state,
    priority: t.priority,
    ...(labelNames ? { labels: labelNames } : { label_ids: t.labels ?? [] }),
    ...(assigneeNames ? { assignees: assigneeNames } : { assignee_ids: t.assignees ?? [] }),
    parent: t.parent ?? null,
    project_id: t.project,
    target_date: t.target_date ?? null,
    updated_at: t.updated_at,
  };
}

// The write shape: deliberately no description. Echoing back a body the caller
// just sent doubled the token cost of every write on the Linear import.
const writeAck = (t) => ({
  id: t?.id,
  sequence_id: t?.sequence_id,
  name: t?.name,
  state: t?.state,
  priority: t?.priority,
  project_id: t?.project,
  updated_at: t?.updated_at,
  description_chars: strip(t?.description_stripped ?? t?.description_html ?? "").length,
});

// Decorate a page of work items with human-readable state/label/assignee names,
// using the per-project caches so this costs three calls per project, not per row.
async function decorate(pid, items, opts = {}) {
  const [st, lb, mb] = await Promise.all([statesOf(pid), labelsOf(pid), membersOf(pid)]);
  const stById = new Map(st.map((s) => [s.id, s.name]));
  const lbById = new Map(lb.map((l) => [l.id, l.name]));
  const mbById = new Map(mb.map(flatMember).map((u) => [u.id, u.display_name ?? u.email ?? u.id]));
  return items.map((t) => slim(t, {
    ...opts,
    stateName: stById.get(t.state) ?? t.state,
    labelNames: (t.labels ?? []).map((id) => lbById.get(id) ?? id),
    assigneeNames: (t.assignees ?? []).map((id) => mbById.get(id) ?? id),
  }));
}

const PRIORITIES = ["urgent", "high", "medium", "low", "none"];

/* ------------------------------ tools ------------------------------ */
const TOOLS = [
  {
    name: "check_api",
    description: "Self-test: probe every Plane endpoint this bridge uses, report which work, which principal the call is acting as, and the RESPONSE ENVELOPE each list endpoint returned. Run this first on a new instance — this bridge was written against Plane's documented API, and this tool is how a wrong assumption shows up as a clear report instead of a silently empty list.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } }, additionalProperties: false },
    run: async ({ project_id }) => {
      const results = [];
      const probe = async (name, fn) => {
        try { results.push({ endpoint: name, ok: true, sample: await fn() }); }
        catch (e) { results.push({ endpoint: name, ok: false, error: String(e.message ?? e) }); }
      };
      let pid = project_id, envelope = null;
      await probe("GET /projects", async () => {
        const r = await planeList(EP.projects());
        envelope = r.envelope;
        if (!pid) pid = r.rows[0]?.id;
        return `${r.rows.length} project(s), envelope=${r.envelope}`;
      });
      if (pid) {
        await probe(`GET /projects/${pid}/work-items`, async () => {
          const r = await planeList(EP.workItems(pid), { per_page: 1 });
          return `${r.rows.length} row(s), envelope=${r.envelope}, count=${r.count ?? "n/a"}`;
        });
        await probe("GET /states", async () => {
          const r = await planeList(EP.states(pid));
          return r.rows.map((s) => `${s.name}[${s.group}]`).join(" | ") || "(none)";
        });
        await probe("GET /labels", async () => {
          const r = await planeList(EP.labels(pid));
          return r.rows.map((l) => l.name).join(", ") || "(none)";
        });
        await probe("GET /members", async () => {
          const r = await planeList(EP.members(pid));
          return r.rows.map((m) => flatMember(m).display_name ?? flatMember(m).email ?? "?").join(", ") || "(none)";
        });
      } else {
        results.push({ endpoint: "work-items/states/labels/members", ok: false, error: "no project to test against" });
      }
      return {
        plane_url: PLANE_API_URL,
        workspace: WORKSPACE,
        acting_as: currentPrincipal().name,
        block_done: BLOCK_DONE,
        allow_delete: ALLOW_DELETE,
        project_envelope: envelope,
        results,
        note: "Writes are not probed. acting_as is whose Plane API key these calls used; permissions differ per principal. If an envelope is not \"results\", read the note at the top of server.js.",
      };
    },
  },
  {
    name: "list_projects",
    description: "Projects in the workspace, with id and name. Plane project ids are UUIDs, not numbers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const r = await planeList(EP.projects());
      return { count: r.rows.length, projects: r.rows.map((p) => ({ id: p.id, name: p.name, identifier: p.identifier })) };
    },
  },
  {
    name: "list_work_items",
    description: "List work items in a project, newest first. Optionally filter by state name or assignee. Descriptions come back as a 500-character preview, flagged when truncated — call get_work_item for the full body.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        state: { type: "string", description: "State name, e.g. \"In Progress\"" },
        assignee: { type: "string", description: "Display name or email, from list_project_members" },
        limit: { type: "number", description: `Max ${PAGE_MAX}` },
        cursor: { type: "string", description: "next_cursor from a previous page" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    run: async ({ project_id, state, assignee, limit = 50, cursor }) => {
      const q = { per_page: Math.min(limit, PAGE_MAX), order_by: "-updated_at" };
      if (cursor) q.cursor = cursor;
      if (state) q.state = (await resolveState(project_id, state)).id;
      if (assignee) q.assignees = (await resolveMembers(project_id, [assignee]))[0].id;
      const r = await planeList(EP.workItems(project_id), q);
      const items = await decorate(project_id, r.rows, { descriptionChars: 500 });
      // Verify the server honoured the filters rather than assuming it did.
      const note = [];
      if (state && items.some((i) => String(i.state).toLowerCase() !== String(state).toLowerCase())) {
        note.push("state filter appears to have been ignored by the server — rows were NOT narrowed here, treat the list as unfiltered");
      }
      if (assignee && items.some((i) => !(i.assignees ?? []).some((a) => String(a).toLowerCase() === String(assignee).toLowerCase()))) {
        note.push("assignee filter appears to have been ignored by the server");
      }
      return { count: items.length, total: r.count ?? null, next_cursor: r.next ?? null, envelope: r.envelope, ...(note.length ? { warning: note.join("; ") } : {}), work_items: items };
    },
  },
  {
    name: "search_work_items",
    description: "Find work items whose name or description matches a search string, within one project. Descriptions previewed at 200 characters.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, query: { type: "string" }, limit: { type: "number" } },
      required: ["project_id", "query"],
      additionalProperties: false,
    },
    run: async ({ project_id, query, limit = 25 }) => {
      const r = await planeList(EP.workItems(project_id), { search: query, per_page: Math.min(limit, PAGE_MAX) });
      return { query, count: r.rows.length, work_items: await decorate(project_id, r.rows, { descriptionChars: 200 }) };
    },
  },
  {
    name: "get_work_item",
    description: "One work item in full, with its state, labels and assignees resolved to names, plus its comments. Nothing truncated.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, work_item_id: { type: "string" } },
      required: ["project_id", "work_item_id"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id }) => {
      const t = await plane(EP.workItem(project_id, work_item_id));
      const [one] = await decorate(project_id, [t]);
      const c = await planeList(EP.comments(project_id, work_item_id));
      return {
        ...one,
        comments: c.rows.map((x) => ({ id: x.id, created_at: x.created_at, actor: x.actor_detail?.display_name ?? x.actor ?? null, comment: strip(x.comment_html ?? x.comment_stripped ?? "") })),
      };
    },
  },
  {
    name: "get_description",
    description: "A work item's description as raw stored HTML. Read this before rewriting one, or to find the exact string for edit_description.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, work_item_id: { type: "string" } },
      required: ["project_id", "work_item_id"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id }) => {
      const t = await plane(EP.workItem(project_id, work_item_id));
      const html = t.description_html ?? "";
      return { work_item_id, name: t.name, chars: html.length, description_html: html };
    },
  },
  {
    name: "create_work_item",
    description: "Create a work item. description is markdown by default and converted to HTML for you. state, labels and assignees are given by NAME and resolved to Plane's UUIDs. Keep the imported key at the front of the name (\"EK-142 ...\") so old references stay searchable.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        description_format: { type: "string", enum: ["markdown", "html"] },
        state: { type: "string", description: "State name; omitted means the project default" },
        priority: { type: "string", enum: PRIORITIES },
        labels: { type: "array", items: { type: "string" } },
        assignees: { type: "array", items: { type: "string" } },
        parent: { type: "string", description: "Parent work item id" },
        target_date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["project_id", "name"],
      additionalProperties: false,
    },
    run: async ({ project_id, name, description, description_format, state, priority, labels, assignees, parent, target_date }) => {
      const body = { name };
      const html = mdToHtml(description, description_format);
      if (html !== undefined) { body.description_html = html; body.description_stripped = strip(html); }
      if (state) body.state = (await resolveState(project_id, state)).id;
      if (priority) {
        if (!PRIORITIES.includes(priority)) throw new Error(`Unknown priority "${priority}". Use one of: ${PRIORITIES.join(", ")}`);
        body.priority = priority;
      }
      if (labels?.length) {
        const { found, missing, all } = await resolveLabels(project_id, labels);
        if (missing.length) throw new Error(`No such label(s): ${missing.join(", ")}. Existing: ${all.map((l) => l.name).join(", ") || "(none)"}. Create them in the UI, or use set_labels with create: true.`);
        body.labels = found.map((l) => l.id);
      }
      if (assignees?.length) body.assignees = (await resolveMembers(project_id, assignees)).map((u) => u.id);
      if (parent) body.parent = parent;
      if (target_date) body.target_date = target_date;
      return writeAck(await plane(EP.workItems(project_id), { method: "POST", body }));
    },
  },
  {
    name: "update_work_item",
    description: "Change fields on a work item. Only what you pass changes. description REPLACES the whole body — use edit_description for a partial change. Moving into a completed or cancelled state is refused while MCP_BLOCK_DONE is on.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        description_format: { type: "string", enum: ["markdown", "html"] },
        state: { type: "string" },
        priority: { type: "string", enum: PRIORITIES },
        parent: { type: "string" },
        target_date: { type: "string" },
      },
      required: ["project_id", "work_item_id"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id, name, description, description_format, state, priority, parent, target_date }) => {
      const body = {};
      if (name !== undefined) body.name = name;
      const html = mdToHtml(description, description_format);
      if (html !== undefined) { body.description_html = html; body.description_stripped = strip(html); }
      if (state !== undefined) {
        const s = await resolveState(project_id, state);
        if (BLOCK_DONE && ["completed", "cancelled"].includes(String(s.group).toLowerCase())) {
          throw new Error(
            `Refused: "${s.name}" is a ${s.group} state, and closing a ticket is a human decision ` +
            `(MCP_BLOCK_DONE). Report the refusal rather than routing around it.`
          );
        }
        body.state = s.id;
      }
      if (priority !== undefined) {
        if (!PRIORITIES.includes(priority)) throw new Error(`Unknown priority "${priority}". Use one of: ${PRIORITIES.join(", ")}`);
        body.priority = priority;
      }
      if (parent !== undefined) body.parent = parent;
      if (target_date !== undefined) body.target_date = target_date;
      if (Object.keys(body).length === 0) throw new Error("Nothing to update — pass at least one field.");
      return writeAck(await plane(EP.workItem(project_id, work_item_id), { method: "PATCH", body }));
    },
  },
  {
    name: "edit_description",
    description: "Replace an exact substring inside a work item's description, server-side, without sending the whole body back. Refuses a missing or ambiguous match instead of guessing. Descriptions are stored as HTML — match the markup, using get_description to see it.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["project_id", "work_item_id", "old_str", "new_str"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id, old_str, new_str, replace_all }) => {
      const t = await plane(EP.workItem(project_id, work_item_id));
      const html = t.description_html ?? "";
      const n = html.split(old_str).length - 1;
      if (n === 0) throw new Error(`old_str not found in the description. Read it with get_description and match the HTML exactly.`);
      if (n > 1 && !replace_all) throw new Error(`old_str appears ${n} times. Pass replace_all: true, or use a longer, unique string.`);
      // Replacer FUNCTION, not a string: $&, $` and $' in new_str would otherwise
      // be interpreted and can inject the surrounding document.
      const next = replace_all ? html.split(old_str).join(new_str) : html.replace(old_str, () => new_str);
      await plane(EP.workItem(project_id, work_item_id), { method: "PATCH", body: { description_html: next, description_stripped: strip(next) } });
      return { work_item_id, replaced: replace_all ? n : 1, chars_before: html.length, chars_after: next.length };
    },
  },
  {
    name: "list_states",
    description: "The states on a project, with their group (backlog, unstarted, started, completed, cancelled). In Plane the state IS the board column — there is no separate bucket concept, so this replaces list_buckets.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false },
    run: async ({ project_id }) => {
      const r = await planeList(EP.states(project_id));
      return { project_id, count: r.rows.length, states: r.rows.map((s) => ({ id: s.id, name: s.name, group: s.group, default: s.default ?? false })) };
    },
  },
  {
    name: "set_state",
    description: "Move a work item to a state by name — the equivalent of moving a card between board columns. Refuses completed and cancelled states while MCP_BLOCK_DONE is on.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, state: { type: "string" } },
      required: ["project_id", "work_item_id", "state"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id, state }) => {
      const s = await resolveState(project_id, state);
      if (BLOCK_DONE && ["completed", "cancelled"].includes(String(s.group).toLowerCase())) {
        throw new Error(`Refused: "${s.name}" is a ${s.group} state (MCP_BLOCK_DONE). Closing a ticket is a human decision.`);
      }
      await plane(EP.workItem(project_id, work_item_id), { method: "PATCH", body: { state: s.id } });
      // Read back: report what happened, not what was intended.
      const after = await plane(EP.workItem(project_id, work_item_id));
      const list = await statesOf(project_id);
      const nowName = list.find((x) => x.id === after.state)?.name ?? after.state;
      return { work_item_id, state: nowName, changed: after.state === s.id };
    },
  },
  {
    name: "list_labels",
    description: "Labels defined on a project, with ids. Plane labels are per-project, unlike Vikunja's instance-wide ones.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false },
    run: async ({ project_id }) => {
      const r = await planeList(EP.labels(project_id));
      return { project_id, count: r.rows.length, labels: r.rows.map((l) => ({ id: l.id, name: l.name, color: l.color })) };
    },
  },
  {
    name: "set_labels",
    description: "Attach labels to a work item by name, creating any that do not exist when create is true. Additive by default; mode \"replace\" makes the label set exactly what is given. Idempotent, so it is safe to re-run across a batch as a repair pass.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["add", "replace"] },
        create: { type: "boolean", description: "Create labels that do not exist yet (default false)" },
      },
      required: ["project_id", "work_item_id", "labels"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id, labels, mode, create }) => {
      const m = mode ?? "add";
      if (m !== "add" && m !== "replace") throw new Error(`Unknown mode "${m}". Use "add" or "replace".`);
      let { found, missing, all } = await resolveLabels(project_id, labels);
      const created = [];
      if (missing.length) {
        if (!create) throw new Error(`No such label(s): ${missing.join(", ")}. Existing: ${all.map((l) => l.name).join(", ") || "(none)"}. Pass create: true to add them.`);
        for (const name of missing) {
          const l = await plane(EP.labels(project_id), { method: "POST", body: { name } });
          found.push(l); created.push(l.name);
        }
        invalidate(project_id);
      }
      const t = await plane(EP.workItem(project_id, work_item_id));
      const current = new Set(t.labels ?? []);
      const wanted = found.map((l) => l.id);
      const final = m === "replace" ? wanted : [...new Set([...current, ...wanted])];
      const added = wanted.filter((id) => !current.has(id));
      const removed = m === "replace" ? [...current].filter((id) => !final.includes(id)) : [];
      if (!added.length && !removed.length && !created.length) {
        return { work_item_id, added: [], removed: [], created: [], changed: false };
      }
      await plane(EP.workItem(project_id, work_item_id), { method: "PATCH", body: { labels: final } });
      const byId = new Map((await labelsOf(project_id)).map((l) => [l.id, l.name]));
      return {
        work_item_id,
        created,
        added: added.map((id) => byId.get(id) ?? id),
        removed: removed.map((id) => byId.get(id) ?? id),
        labels: final.map((id) => byId.get(id) ?? id),
        changed: true,
      };
    },
  },
  {
    name: "list_project_members",
    description: "Everyone who can be assigned on a project, with the id assignment needs. Call this when unsure of a name — assignment takes UUIDs and a non-member cannot be assigned at all.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false },
    run: async ({ project_id }) => {
      const r = await planeList(EP.members(project_id));
      const members = r.rows.map(flatMember);
      return { project_id, count: members.length, members, envelope: r.envelope };
    },
  },
  {
    name: "assign_work_item",
    description: "Put people on a work item, by display name, email or id. Additive by default; mode \"replace\" makes the assignee list exactly the people given. Idempotent — assigning someone already on it is a no-op, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
        assignees: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["add", "replace"] },
      },
      required: ["project_id", "work_item_id", "assignees"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id, assignees, mode }) => {
      const m = mode ?? "add";
      if (m !== "add" && m !== "replace") throw new Error(`Unknown mode "${m}". Use "add" or "replace".`);
      if (!Array.isArray(assignees) || assignees.length === 0) {
        throw new Error(`assignees is empty. To clear a work item use unassign_work_item with all: true.`);
      }
      const wanted = await resolveMembers(project_id, assignees);
      const t = await plane(EP.workItem(project_id, work_item_id));
      const current = new Set(t.assignees ?? []);
      const ids = wanted.map((u) => u.id);
      const final = m === "replace" ? ids : [...new Set([...current, ...ids])];
      const added = ids.filter((id) => !current.has(id));
      const removed = m === "replace" ? [...current].filter((id) => !final.includes(id)) : [];
      if (!added.length && !removed.length) {
        return { work_item_id, added: [], removed: [], already: wanted.map((u) => u.display_name ?? u.id), changed: false };
      }
      await plane(EP.workItem(project_id, work_item_id), { method: "PATCH", body: { assignees: final } });
      const after = await plane(EP.workItem(project_id, work_item_id));
      const byId = new Map((await membersOf(project_id)).map(flatMember).map((u) => [u.id, u.display_name ?? u.email ?? u.id]));
      const actual = (after.assignees ?? []).map((id) => byId.get(id) ?? id);
      const drift = actual.length !== final.length;
      return {
        work_item_id,
        added: added.map((id) => byId.get(id) ?? id),
        removed: removed.map((id) => byId.get(id) ?? id),
        assignees: actual,
        changed: true,
        ...(drift ? { drift: true, warning: "Plane did not apply the assignee list as sent — report this rather than retrying." } : {}),
      };
    },
  },
  {
    name: "unassign_work_item",
    description: "Take people off a work item, or pass all: true to clear it. Implemented by re-setting the assignee list to whoever remains, so it needs no delete permission.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
        assignees: { type: "array", items: { type: "string" } },
        all: { type: "boolean" },
      },
      required: ["project_id", "work_item_id"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id, assignees, all }) => {
      const clearAll = all === true;
      if (!clearAll && (!Array.isArray(assignees) || assignees.length === 0)) {
        throw new Error("Nothing to remove: pass assignees, or all: true to clear every assignee.");
      }
      const t = await plane(EP.workItem(project_id, work_item_id));
      const current = t.assignees ?? [];
      const byId = new Map((await membersOf(project_id)).map(flatMember).map((u) => [u.id, u]));
      if (current.length === 0) return { work_item_id, removed: [], assignees: [], changed: false };
      // Matched against who is ON the item, not the member list: someone removed
      // from the project can still be assigned, and still has to be removable.
      const want = clearAll ? null : assignees.map((a) => String(a).trim().toLowerCase());
      const hit = (id) => {
        if (clearAll) return true;
        const u = byId.get(id);
        return want.includes(String(id).toLowerCase())
          || (u && (want.includes(String(u.display_name ?? "").toLowerCase()) || want.includes(String(u.email ?? "").toLowerCase())));
      };
      const removed = current.filter(hit);
      const keep = current.filter((id) => !hit(id));
      const name = (id) => byId.get(id)?.display_name ?? byId.get(id)?.email ?? id;
      const notAssigned = clearAll ? [] : assignees.map(String).filter((a) => !removed.some((id) => String(name(id)).toLowerCase() === a.trim().toLowerCase() || String(id) === a));
      if (!removed.length) return { work_item_id, removed: [], not_assigned: notAssigned, assignees: current.map(name), changed: false };
      await plane(EP.workItem(project_id, work_item_id), { method: "PATCH", body: { assignees: keep } });
      const after = await plane(EP.workItem(project_id, work_item_id));
      const actual = (after.assignees ?? []).map(name);
      return {
        work_item_id,
        removed: removed.map(name),
        not_assigned: notAssigned,
        assignees: actual,
        changed: true,
        ...(actual.length !== keep.length ? { drift: true, warning: "Plane did not apply the assignee list as sent." } : {}),
      };
    },
  },
  {
    name: "add_comment",
    description: "Comment on a work item. markdown by default and converted to HTML, same as descriptions. Pass comment_format: \"html\" to opt out.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
        comment: { type: "string" },
        comment_format: { type: "string", enum: ["markdown", "html"] },
      },
      required: ["project_id", "work_item_id", "comment"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id, comment, comment_format }) => {
      const html = mdToHtml(comment, comment_format);
      const c = await plane(EP.comments(project_id, work_item_id), {
        method: "POST",
        body: { comment_html: html, comment_stripped: strip(html) },
      });
      return { id: c?.id, work_item_id, created_at: c?.created_at, chars: strip(html).length };
    },
  },
  {
    name: "set_parent",
    description: "Make one work item the child of another, which is how Plane models sub-issues. Pass parent: null to detach. Plane keeps the inverse side itself.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, work_item_id: { type: "string" }, parent: { type: ["string", "null"] } },
      required: ["project_id", "work_item_id"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id, parent }) => {
      if (parent && parent === work_item_id) throw new Error("A work item cannot be its own parent.");
      await plane(EP.workItem(project_id, work_item_id), { method: "PATCH", body: { parent: parent ?? null } });
      const after = await plane(EP.workItem(project_id, work_item_id));
      return { work_item_id, parent: after.parent ?? null, changed: (after.parent ?? null) === (parent ?? null) };
    },
  },
  {
    name: "add_link",
    description: "Attach a URL to a work item as a link. This is the migration path for Linear attachments and for pointing back at an original issue. Blocks non-https URLs and private, loopback and link-local addresses, and honours the MCP_FETCH_ALLOW_HOSTS allowlist when set.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        work_item_id: { type: "string" },
        url: { type: "string" },
        title: { type: "string" },
      },
      required: ["project_id", "work_item_id", "url"],
      additionalProperties: false,
    },
    run: async ({ project_id, work_item_id, url, title }) => {
      const u = new URL(url);
      if (u.protocol !== "https:") throw new Error(`Refused: only https URLs are allowed, got "${u.protocol}".`);
      const host = u.hostname.toLowerCase();
      const isPrivate =
        host === "localhost" || host.endsWith(".localhost") ||
        /^(127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd)/i.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host);
      if (isPrivate) throw new Error(`Refused: "${host}" is a private or loopback address. This bridge does not fetch internal addresses.`);
      if (FETCH_ALLOW_HOSTS.length && !FETCH_ALLOW_HOSTS.includes(host)) {
        throw new Error(`Refused: "${host}" is not in MCP_FETCH_ALLOW_HOSTS (${FETCH_ALLOW_HOSTS.join(", ")}).`);
      }
      const l = await plane(EP.links(project_id, work_item_id), { method: "POST", body: { url, title: title ?? u.hostname } });
      return { id: l?.id, work_item_id, url, title: l?.title ?? title ?? null };
    },
  },
];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/* ---------------------------- JSON-RPC ---------------------------- */
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(msg) {
  const { id, method, params } = msg ?? {};
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "plane-mcp", version: "0.1.0" },
      });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return rpcResult(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = BY_NAME[params?.name];
      if (!tool) return rpcError(id, -32601, `Unknown tool: ${params?.name}`);
      try {
        const out = await tool.run(params?.arguments ?? {});
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: String(e.message ?? e) }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Unknown method: ${method}`);
  }
}

/* ------------------------------ HTTP ------------------------------ */
// Constant-time comparison against every principal, with no early exit, so the
// work done does not reveal which token was presented.
function resolvePrincipal(header) {
  const presented = String(header ?? "").replace(/^Bearer\s+/i, "");
  let match = null;
  for (const p of PRINCIPALS) {
    let diff = presented.length === p.auth.length ? 0 : 1;
    const n = Math.max(presented.length, p.auth.length);
    for (let i = 0; i < n; i++) diff |= (presented.charCodeAt(i) ?? 0) ^ (p.auth.charCodeAt(i) ?? 0);
    if (diff === 0) match = p;
  }
  return match;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const server = http.createServer((req, res) => {
  const started = Date.now();
  let who = "-";
  const done = (code, note = "") => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${code} auth=${req.headers.authorization ? "present" : "absent"} as=${who} ${note} (${Date.now() - started}ms)`);
  };

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return done(204); }
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({ ok: true }));
    return done(200);
  }
  if (req.url !== "/mcp") { res.writeHead(404, CORS); res.end(); return done(404); }
  // 405 (not 404) on GET /mcp: clients probe this, and a 404 makes them report
  // an unhelpful "couldn't reach the server".
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST, OPTIONS", ...CORS });
    res.end();
    return done(405);
  }

  const principal = resolvePrincipal(req.headers.authorization);
  if (!principal) {
    res.writeHead(401, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return done(401, "(token mismatch)");
  }
  who = principal.name;

  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    let msg;
    try { msg = JSON.parse(body); } catch {
      res.writeHead(400, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(rpcError(null, -32700, "Parse error")));
      return done(400);
    }
    const out = await callerCtx.run(principal, () => handleRpc(msg));
    if (out === null) { res.writeHead(202, CORS); res.end(); return done(202, `(${msg?.method})`); }
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify(out));
    done(200, `(${msg?.method})`);
  });
});

server.listen(PORT, () => {
  console.log(
    `plane-mcp on :${PORT} -> ${PLANE_API_URL} workspace=${WORKSPACE} ` +
    `(block_done=${BLOCK_DONE} allow_delete=${ALLOW_DELETE}) principals=${PRINCIPALS.map((p) => p.name).join(",")}`
  );
});
