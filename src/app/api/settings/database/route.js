import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb, mergeDb, analyzeImport } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";

export async function GET() {
  try {
    const payload = await exportDb();
    return NextResponse.json(payload);
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json({ error: "Failed to export database" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const url = new URL(request.url);
    const payload = await request.json();
    const analyze = url.searchParams.get("analyze") === "1" || payload?._analyze === true;
    const mode = url.searchParams.get("mode") || payload?._mode || "replace";
    const conflict = url.searchParams.get("conflict") || payload?._conflict || "skip";
    if (payload && typeof payload === "object") {
      delete payload._mode;
      delete payload._analyze;
      delete payload._conflict;
    }

    // Dry-run: report conflicts without writing anything.
    if (analyze) {
      const report = await analyzeImport(payload);
      return NextResponse.json({ success: true, report });
    }

    if (mode === "merge" || mode === "add") {
      await mergeDb(payload, { conflictStrategy: conflict === "overwrite" ? "overwrite" : "skip" });
    } else {
      await importDb(payload);
    }

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 }
    );
  }
}
