const fs = require('fs');
let code = fs.readFileSync('src/dashboard-js-events.ts', 'utf8');

// Replace the literal backticks inside the inner string with escaped ones or just use single/double quotes.
code = code.replace(
  /list\.innerHTML = matches\.map\(m => `<li class="px-3 py-1\.5 hover:bg-base-700 cursor-pointer mention-item" data-name="\$\{m\}">@\$\{m\}<\/li>`\)\.join\(''\);/,
  "list.innerHTML = matches.map(m => '<li class=\"px-3 py-1.5 hover:bg-base-700 cursor-pointer mention-item\" data-name=\"' + m + '\">@' + m + '</li>').join('');"
);

fs.writeFileSync('src/dashboard-js-events.ts', code);
