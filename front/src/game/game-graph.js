// ════════════════════════════════════════════════════════════════════════════
// game/game-graph.js — [design: reuse the graph from the graph page] The
// game's neighbour-fetch, over the SAME /api/v1/graph endpoint the Explorer's
// own search uses (../api/api.js). The point of the branching web is that a
// player builds their line by CLICKING real collaborators on the graph, not by
// typing — so this is the data half of "play on the graph, not the keyboard":
// one hop of the real collaboration graph around the focused artist, handed to
// chain-graph.js to render as the clickable dandelion around the focus.
//
// Deliberately the real public graph endpoint, not a game-private one: the
// collaborators the player sees here are exactly the collaborators the Explorer
// would show for the same artist (same L1 data, same role coverage), so the two
// surfaces never disagree about who someone has worked with. role_mask is
// pinned to all four roles (primary,producer,writer,featured) to match the
// game's own server-side validator (chain_validator uses the all-roles mask):
// every collaborator shown here is one the submit check will also accept.
//
// Same failure posture as game-api.js: any non-ok status or transport error
// resolves to null, and the caller (connect.js::refreshFrontier) surfaces that
// as an honest "no graph data / couldn't load" state rather than a fake puff.
// ════════════════════════════════════════════════════════════════════════════
import { apiFetch } from "../api/net.js";

// All four collaboration roles — the game is not role-filtered (unlike the
// Explorer, whose default omits "primary"); this matches the game service's
// own kAllRolesMask so the frontier and the anti-cheat validator agree.
const GAME_ROLES = "primary,producer,writer,featured";

// One hop of the real graph around artist `id`.
// Returns { seedId, seedName, neighbours: [{ id, name, image }] } — the focus's
// direct collaborators, the seed itself filtered out — or null on failure.
export async function fetchNeighbours(id) {
  if (id == null) return null;
  try {
    // Same shape the Explorer's "show more"/expand uses: ?id=<seed> asks for
    // that artist's own graph rather than resolving a typed name first.
    const url = `/api/v1/graph?id=${encodeURIComponent(id)}&roles=${encodeURIComponent(GAME_ROLES)}`;
    const res = await apiFetch(url);
    if (!res.ok) return null;
    const graph = await res.json();
    if (!graph || !Array.isArray(graph.nodes)) return null;

    const seedId = graph.seed_id ?? id;
    const seedName = graph.seed || "";
    const neighbours = graph.nodes
      .filter(n => n && n.id != null && n.id !== seedId)
      .map(n => ({ id: n.id, name: n.name || "", image: n.image || null }));

    return { seedId, seedName, neighbours };
  } catch {
    return null;
  }
}
