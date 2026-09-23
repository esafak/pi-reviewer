import { validate } from "@octokit/graphql-schema";
import { githubGraphqlDocuments, githubResearchGraphqlDocuments } from "../src/ci/github.js";

let failed = false;
const documents = { ...githubGraphqlDocuments, ...githubResearchGraphqlDocuments };
for (const [name, document] of Object.entries(documents)) {
  const errors = validate(document);
  for (const error of errors) {
    failed = true;
    console.error(`[graphql] ${name}: ${error.message}`);
  }
}

if (failed) process.exitCode = 1;
else console.log(`[graphql] validated ${Object.keys(documents).length} documents`);
