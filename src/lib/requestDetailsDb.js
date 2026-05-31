// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getRequestDetailProviders,
} from "@/lib/db/index.js";
