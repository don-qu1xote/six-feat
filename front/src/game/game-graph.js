import { apiFetch } from "../api/net.js";

const GAME_ROLES = "primary,producer,writer,featured";

export async function fetchNeighbours(id) {
  if (id == null) return null;
  try {
    const url = `/api/v1/graph?id=${encodeURIComponent(id)}&roles=${encodeURIComponent(GAME_ROLES)}`;
    const res = await apiFetch(url);
    if (!res.ok) return null;
    const graph = await res.json();
    if (!graph || !Array.isArray(graph.nodes)) return null;

    const seedId = graph.seedId ?? id;
    const seedName = graph.seed || "";
    const neighbours = graph.nodes
      .filter((n) => n && n.id != null && n.id !== seedId)
      .map((n) => ({ id: n.id, name: n.name || "", image: n.image || null }));

    return { seedId, seedName, neighbours };
  } catch {
    return null;
  }
}
