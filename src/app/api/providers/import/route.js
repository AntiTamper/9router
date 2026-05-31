import { NextResponse } from "next/server";
import {
  getProviderConnections,
  createProviderConnection,
  updateProviderConnection,
} from "@/models";

export const dynamic = "force-dynamic";

function connDedupKey(c) {
  if (c.authType === "oauth" && c.email) {
    const ws = c.providerSpecificData && c.providerSpecificData.chatgptAccountId;
    return `conn:oauth:${c.provider}:${c.email}:${ws || ""}`;
  }
  if (c.authType === "apikey" && c.name) {
    return `conn:apikey:${c.provider}:${c.name}`;
  }
  return null;
}

// Import one or more provider token/session connections individually (add).
// Body: a single connection object, or { connections: [...] }.
// Query: ?analyze=1 to report conflicts only; ?conflict=skip|overwrite (default skip).
export async function POST(request) {
  try {
    const url = new URL(request.url);
    const body = await request.json();
    const analyze = url.searchParams.get("analyze") === "1";
    const conflict = url.searchParams.get("conflict") === "overwrite" ? "overwrite" : "skip";

    const incoming = Array.isArray(body?.connections)
      ? body.connections
      : Array.isArray(body)
        ? body
        : (body && typeof body === "object" ? [body] : []);

    if (incoming.length === 0) {
      return NextResponse.json({ error: "No provider connection supplied" }, { status: 400 });
    }
    for (const c of incoming) {
      if (!c || !c.provider) {
        return NextResponse.json({ error: "Each connection requires a 'provider'" }, { status: 400 });
      }
    }

    const existing = await getProviderConnections();
    const idSet = new Set(existing.map((r) => r.id));
    const keyToId = new Map();
    for (const r of existing) { const k = connDedupKey(r); if (k) keyToId.set(k, r.id); }

    const matchId = (c) => {
      if (c.id && idSet.has(c.id)) return c.id;
      const k = connDedupKey(c);
      if (k && keyToId.has(k)) return keyToId.get(k);
      return null;
    };

    if (analyze) {
      let adds = 0, conflicts = 0;
      const conflictNames = [];
      for (const c of incoming) {
        if (matchId(c)) { conflicts++; conflictNames.push(c.name || c.email || c.provider); }
        else adds++;
      }
      return NextResponse.json({ success: true, report: { adds, conflicts, conflictNames } });
    }

    let added = 0, overwritten = 0, skipped = 0;
    for (const c of incoming) {
      const conflictId = matchId(c);
      if (conflictId) {
        if (conflict !== "overwrite") { skipped++; continue; }
        await updateProviderConnection(conflictId, c);
        overwritten++;
      } else {
        await createProviderConnection(c);
        added++;
      }
    }

    return NextResponse.json({ success: true, added, overwritten, skipped });
  } catch (error) {
    console.log("Error importing provider connection:", error);
    return NextResponse.json({ error: error?.message || "Failed to import provider connection" }, { status: 400 });
  }
}