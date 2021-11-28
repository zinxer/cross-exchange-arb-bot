browserify index.js --no-bundle-external --node | uglifyjs -c > bundle.js && javascript-obfuscator bundle.js --output compiled.js --compact true
rm bundle.js