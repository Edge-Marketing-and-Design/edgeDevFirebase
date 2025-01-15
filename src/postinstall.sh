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


# Check if the destination file exists
if [ ! -f "$project_root/storage.rules" ]; then
  # If the file does not exist, create it and add the rules_version line
  echo "rules_version = '2';" > "$project_root/storage.rules";
fi

# Ensure there's a newline at the end of the file
[ "$(tail -c1 $project_root/storage.rules)" != "" ] && echo "" >> "$project_root/storage.rules"

# Remove the existing block of rules between the markers
sed -i.backup '/\/\/ #EDGE FIREBASE RULES START/,/\/\/ #EDGE FIREBASE RULES END/d' "$project_root/storage.rules"

# Extract the code block from the source file and append it to the destination file
awk '/\/\/ #EDGE FIREBASE RULES START/,/\/\/ #EDGE FIREBASE RULES END/' ./src/storage.rules | \
  sed '1d;$d' | \
  sed -e '1s/^/\/\/ #EDGE FIREBASE RULES START\n/' -e '$s/$/\n\/\/ #EDGE FIREBASE RULES END/' \
  >> "$project_root/storage.rules";

if [ ! -d "$project_root/functions" ]; then
  mkdir "$project_root/functions"
fi

cp ./src/edgeFirebase.js "$project_root/functions/edgeFirebase.js"
cp ./src/config.js "$project_root/functions/config.js"

if [ ! -f "$project_root/functions/index.js" ]; then
  cp ./src/index.js "$project_root/functions/index.js"
fi

if [ ! -f "$project_root/functions/.env.dev" ]; then
  cp ./src/.env.dev "$project_root/functions/.env.dev"
fi

if [ ! -f "$project_root/functions/.env.prod" ]; then
  cp ./src/.env.prod "$project_root/functions/.env.prod"
fi

if [ ! -f "$project_root/.env.dev" ]; then
  cp ./src/.env.development "$project_root/.env.dev"
fi

if [ ! -f "$project_root/.env" ]; then
  cp ./src/.env.production "$project_root/.env"
fi

if [ ! -f "$project_root/functions/package.json" ]; then
  cp ./src/package.json "$project_root/functions/package.json"
  cd "$project_root/functions"
  npm install --no-audit --silent
  cd "$project_root"
fi

# Upgrade specific npm packages in the functions directory
cd "$project_root/functions"

# List of packages to upgrade
npm install --save \
    "@google-cloud/pubsub@^4.9.0" \
    "aws-sdk@^2.1692.0" \
    "crypto@^1.0.1" \
    "dotenv@^16.3.1" \
    "exceljs@^4.4.0" \
    "firebase-admin@^13.0.2" \
    "firebase-functions@^6.2.0" \
    "form-data@^4.0.0" \
    "formidable-serverless@^1.1.1" \
    "moment-timezone@^0.5.43" \
    "openai@^4.11.1" \
    "stripe@^13.8.0" \
    "twilio@^4.18.0"

# Return to the project root
cd "$project_root"