import { afterEach } from "vitest";
import { resetDbAdapterForTests } from "../../src/lib/db/driver.js";

afterEach(() => {
  resetDbAdapterForTests();
});
