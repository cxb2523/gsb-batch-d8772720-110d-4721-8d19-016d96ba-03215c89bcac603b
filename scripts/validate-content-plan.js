"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { validateContentPlan } = require("../content-plan-policy");

function parseArguments(argv) {
  const options = { planPath: "", startDate: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--start-date") {
      options.startDate = String(argv[++index] || "");
    } else if (!value.startsWith("--") && !options.planPath) {
      options.planPath = value;
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (!options.planPath) throw new Error("usage: validate-content-plan <plan.json> --start-date YYYY-MM-DD");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const planPath = path.resolve(options.planPath);
  const records = JSON.parse(await fs.readFile(planPath, "utf8"));
  const result = validateContentPlan(records, { startDate: options.startDate });
  const { items, ...summary } = result;
  console.log(JSON.stringify({ ...summary, plan_path: planPath }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments };
