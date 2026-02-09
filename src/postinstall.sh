#!/bin/bash

# Resolve the symlink and get the actual directory path
actual_dir=$(readlink -f $(dirname $0))
# Get the project root directory by removing the node_modules directory path
project_root=$(echo "$actual_dir" | awk '{gsub(/node_modules.*$/, ""); print}')

merge_env_file () {
  local src="$1"
  local dest="$2"

  if [ ! -f "$src" ]; then
    return
  fi

  if [ ! -f "$dest" ]; then
    cp "$src" "$dest"
    return
  fi

  [ "$(tail -c1 "$dest")" != "" ] && echo "" >> "$dest"

  while IFS= read -r line; do
    if [ -z "$line" ]; then
      continue
    fi
    if echo "$line" | grep -qE '^[A-Za-z0-9_]+='; then
      key="${line%%=*}"
      if ! grep -qE "^${key}=" "$dest"; then
        echo "$line" >> "$dest"
      fi
    fi
  done < "$src"
}

merge_package_json () {
  local src="$1"
  local dest="$2"

  if [ ! -f "$src" ] || [ ! -f "$dest" ]; then
    return
  fi

  node - "$src" "$dest" <<'NODE'
const fs = require('fs')
const [,, srcPath, destPath] = process.argv
const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'))
const dest = JSON.parse(fs.readFileSync(destPath, 'utf8'))
const sections = ['dependencies', 'devDependencies']

for (const section of sections) {
  const srcDeps = src[section] || {}
  if (!dest[section])
    dest[section] = {}
  for (const [name, version] of Object.entries(srcDeps)) {
    if (!dest[section][name])
      dest[section][name] = version
  }
}

fs.writeFileSync(destPath, `${JSON.stringify(dest, null, 2)}\n`)
NODE
}


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
cp ./src/cms.js "$project_root/functions/cms.js"

if [ ! -d "$project_root/functions/kv" ]; then
  mkdir -p "$project_root/functions/kv"
fi

cp ./src/kv/*.js "$project_root/functions/kv/"

if [ ! -f "$project_root/functions/index.js" ]; then
  cp ./src/index.js "$project_root/functions/index.js"
else
  sed -i.backup '/\/\/ START @edge\/firebase functions/,/\/\/ END @edge\/firebase functions/d' "$project_root/functions/index.js"
  [ "$(tail -c1 $project_root/functions/index.js)" != "" ] && echo "" >> "$project_root/functions/index.js"
  awk '/\/\/ START @edge\/firebase functions/,/\/\/ END @edge\/firebase functions/' ./src/functions.js | \
    sed '1d;$d' | \
    sed -e '1s/^/\/\/ START @edge\/firebase functions\n/' -e '$s/$/\n\/\/ END @edge\/firebase functions/' \
    >> "$project_root/functions/index.js";
fi

merge_env_file "./src/.env.dev" "$project_root/functions/.env.dev"
merge_env_file "./src/.env.prod" "$project_root/functions/.env.prod"
merge_env_file "./src/.env.development" "$project_root/.env.dev"
merge_env_file "./src/.env.production" "$project_root/.env"

if [ ! -f "$project_root/functions/package.json" ]; then
  cp ./src/package.json "$project_root/functions/package.json"
else
  merge_package_json "$actual_dir/package.json" "$project_root/functions/package.json"
fi
