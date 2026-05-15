import { NextResponse } from "next/server";
import { execSync } from "node:child_process";

export const dynamic = "force-dynamic";

function isElevated() {
  if (process.platform === "win32") {
    try {
      execSync("net session >nul 2>&1", { windowsHide: true, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export async function GET() {
  try {
    const elevated = isElevated();
    return NextResponse.json({
      elevated,
      status: elevated ? "elevated" : "user",
    });
  } catch {
    return NextResponse.json({ elevated: false, status: "user" });
  }
}
