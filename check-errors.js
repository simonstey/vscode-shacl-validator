const { execSync } = require("child_process");
try {
  const output = execSync("npx tsc --noEmit", { encoding: "utf8" });
  console.log("TypeScript check passed!");
} catch (error) {
  console.error("TypeScript errors:");
  console.error(error.stdout);
}
