#!/bin/bash

# Check if the destination file exists
if [ ! -f ./firestore.rules ]; then
  # If the file does not exist, create it and add the rules_version line
  echo "rules_version = '2';" > ./firestore.rules;
fi

[ "$(tail -c1 ./firestore.rules)" != "" ] && echo "" >> ./firestore.rules

# Extract the code block from the source file and append it to the destination file
sed -i.backup '/\/\/ #EDGE FIREBASE RULES START/,/\/\/ #EDGE FIREBASE RULES END/d' ./firestore.rules

awk '/\/\/ #EDGE FIREBASE RULES START/,/\/\/ #EDGE FIREBASE RULES END/' ./node_modules/@edgedev/firebase/src/firestore.rules | \
  sed '1d;$d' | \
  sed -e '1s/^/\/\/ #EDGE FIREBASE RULES START\n/' -e '$s/$/\n\/\/ #EDGE FIREBASE RULES END/' \
  >> ./firestore.rules;

if [ ! -f ./functions/index.js ]; then
  mkdir -p ./functions
  echo "const functions = require('firebase-functions');" > ./functions/index.js;
  echo "const admin = require('firebase-admin');" >> ./functions/index.js;
  echo "admin.initializeApp();" >> ./functions/index.js;
  echo "const db = admin.firestore();" >> ./functions/index.js;
fi   

[ "$(tail -c1 ./firestore.rules)" != "" ] && echo "" >> ./functions/index.js

sed -i.backup '/\/\/ START @edge\/firebase functions/,/\/\/ END @edge\/firebase functions/d' ./functions/index.js

awk '/\/\/ START @edge\/firebase functions/,/\/\/ END @edge\/firebase functions/' ./node_modules/@edgedev/firebase/src/functions.js | \
  sed '1d;$d' | \
  sed -e '1s/^/\/\/ START @edge\/firebase functions\n/' -e '$s/$/\n\/\/ END @edge\/firebase functions/' \
  >> ./functions/index.js;