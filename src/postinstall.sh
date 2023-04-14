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

if [ ! -f ./functions/index.js ]; then
  mkdir -p ./functions
  echo "const functions = require('firebase-functions');" > ./functions/index.js;
  echo "const admin = require('firebase-admin');" >> ./functions/index.js;
  echo "admin.initializeApp();" >> ./functions/index.js;
  echo "const db = admin.firestore();" >> ./functions/index.js;
fi   

[ "$(tail -c1 $project_root/functions/index.js)" != "" ] && echo "" >> "$project_root/functions/index.js"

sed -i.backup '/\/\/ START @edge\/firebase functions/,/\/\/ END @edge\/firebase functions/d' "$project_root/functions/index.js"

awk '/\/\/ START @edge\/firebase functions/,/\/\/ END @edge\/firebase functions/' ./src/functions.js | \
  sed '1d;$d' | \
  sed -e '1s/^/\/\/ START @edge\/firebase functions\n/' -e '$s/$/\n\/\/ END @edge\/firebase functions/' \
  >> "$project_root/functions/index.js";