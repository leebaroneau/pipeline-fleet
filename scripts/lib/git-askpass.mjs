#!/usr/bin/env node

const prompt = process.argv[2] || "";

if (/username/i.test(prompt)) {
  process.stdout.write(process.env.GIT_AUTH_USERNAME || "x-access-token");
} else if (/password/i.test(prompt)) {
  process.stdout.write(process.env.GIT_AUTH_TOKEN || "");
}
