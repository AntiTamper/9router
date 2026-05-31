import { NextResponse } from "next/server";
import { execFileSync } from "node:child_process";

export const dynamic = "force-dynamic";

function isElevated() {
  if (process.platform === "win32") {
    try {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent(); if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'elevated' } else { 'user' }",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
          windowsHide: true,
        },
      );
      return output.trim() === "elevated";
    } catch {}

    try {
      execFileSync("net", ["session"], {
        stdio: "ignore",
        timeout: 3000,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// Cache the result briefly so repeated dashboard polls do not spawn a new
// powershell.exe per request (process-spawn amplification / DoS guard).
const ELEVATION_TTL_MS = 30_000;
let cached = { value: null, at: 0 };

export async function GET() {
  try {
    const nowTs = Date.now();
    if (cached.value !== null && nowTs - cached.at < ELEVATION_TTL_MS) {
      const elevated = cached.value;
      return NextResponse.json({ elevated, status: elevated ? "elevated" : "user" });
    }
    const elevated = isElevated();
    cached = { value: elevated, at: nowTs };
    return NextResponse.json({
      elevated,
      status: elevated ? "elevated" : "user",
    });
  } catch {
    return NextResponse.json({ elevated: false, status: "user" });
  }
}
