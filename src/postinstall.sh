#!/bin/bash

# Resolve the symlink and get the actual directory path
actual_dir=$(readlink -f $(dirname $0))
# Get the project root directory by removing the node_modules directory path
project_root=$(echo "$actual_dir" | awk '{gsub(/node_modules.*$/, ""); print}')


# Check if the destination file exists
if [ ! -f "$project_root/firestore.rules" ]; then
  # If the file does not exist, create it and add the rules_version line
  echo "rules_version = '2';" > "$project_root/firestore.rules";
fi

[ "$(tail -c1 $project_root/firestore.rules)" != "" ] && echo "" >> "$project_root/firestore.rules"

# # Extract the code block from the source file and append it to the destination file
sed -i.backup '/\/\/ #EDGE FIREBASE RULES START/,/\/\/ #EDGE FIREBASE RULES END/d' "$project_root/firestore.rules"

awk '/\/\/ #EDGE FIREBASE RULES START/,/\/\/ #EDGE FIREBASE RULES END/' ./src/firestore.rules | \
  sed '1d;$d' | \
  sed -e '1s/^/\/\/ #EDGE FIREBASE RULES START\n/' -e '$s/$/\n\/\/ #EDGE FIREBASE RULES END/' \
  >> "$project_root/firestore.rules";

if [ ! -f "$project_root/functions/index.js" ]; then
  mkdir -p "$project_root/functions"
  echo "require('dotenv').config({ path: process.env.NODE_ENV === 'production' ? '.env.prod' : '.env.dev' })" > "$project_root/functions/index.js";
fi

cp ./src/edgeFirebase.js "$project_root/functions/edgeFirebase.js"
cp ./src/config.js "$project_root/functions/config.js"

if [ ! -f "$project_root/functions/.env.dev" ]; then
  cp ./src/.env.dev "$project_root/functions/.env.dev"
fi

if [ ! -f "$project_root/functions/.env.prod" ]; then
  cp ./src/.env.prod "$project_root/functions/.env.prod"
fi

if [ ! -f "$project_root/.env.development" ]; then
  cp ./src/.env.dev "$project_root/.env.development"
fi

if [ ! -f "$project_root/.env.production" ]; then
  cp ./src/.env.prod "$project_root/functions/.env.production"
fi

if [ ! -f "$project_root/functions/package.json" ]; then
  cp ./src/package.json "$project_root/functions/package.json"
  cd "$project_root/functions"
  npm install --no-audit --silent
  cd "$project_root"
fi

[ "$(tail -c1 $project_root/functions/index.js)" != "" ] && echo "" >> "$project_root/functions/index.js"

sed -i.backup '/\/\/ START @edge\/firebase functions/,/\/\/ END @edge\/firebase functions/d' "$project_root/functions/index.js"

awk '/\/\/ START @edge\/firebase functions/,/\/\/ END @edge\/firebase functions/' ./src/functions.js | \
  sed '1d;$d' | \
  sed -e '1s/^/\/\/ START @edge\/firebase functions\n/' -e '$s/$/\n\/\/ END @edge\/firebase functions/' \
  >> "$project_root/functions/index.js";