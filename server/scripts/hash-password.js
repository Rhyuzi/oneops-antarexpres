"use strict";

/** Usage: npm run hash-password 'YourPassword' → prints bcrypt hash. */

const bcrypt = require("bcryptjs");

const pw = process.argv[2];
if (!pw) {
  console.error("Usage: npm run hash-password 'YourPassword'");
  process.exit(1);
}

bcrypt.hash(pw, 10).then((hash) => {
  console.log(hash);
});
