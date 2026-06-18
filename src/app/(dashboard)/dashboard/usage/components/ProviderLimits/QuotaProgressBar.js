"use client";

import { QuotaBarRow } from "./QuotaTable";

export default function QuotaProgressBar({ percentage = 0, label = "", used = 0, total = 0, resetTime = null }) {
  return (
    <QuotaBarRow
      label={label}
      quota={{ name: label, used, total, resetAt: resetTime, remainingPercentage: percentage }}
    />
  );
}