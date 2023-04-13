#!/bin/bash

# Check if the destination file exists
if [ ! -f ./firestore.rules ]; then
  # If the file does not exist, create it and add the rules_version line
  echo 'rules_version = '\''2'\'';' > ./firestore.rules;
else
  # If the file exists, add the rules_version line at the beginning using sed
  sed -i '1s/^/rules_version = \\'\''2\\'\'';\\n/' ./firestore.rules;
fi

# Extract the code block from the source file and append it to the destination file
awk '/\/\/ #EDGE FIREBASE RULES START/,/\/\/ #EDGE FIREBASE RULES END/' ./src/firestore.rules | \
  sed 's/\\/\\\\/g; s/&/\\&/g' | \
  sed -e 's/\"/\\\\\"/g' -e 's/\//\\\\\//g' | \
  sed -e '1s/^/\/\/ #EDGE FIREBASE RULES START\n/' -e '$s/$/\n\/\/ #EDGE FIREBASE RULES END/' \
  >> ./firestore.rules;
