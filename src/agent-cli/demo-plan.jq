# A ticket variation's demo plan (ASS-76), its one shape check: the filter
# ticket:demo-plan runs over demo-plan-<variation>.json and ticket:set-demo-plan
# (ASS-180) over its stdin. Prints just the fields of { demo: true, setup,
# ready-check, view: { with: browser, address | terminal, commands | other,
# how }, look-at } or { demo: false, why }; null — jq -e exits 1 — otherwise.
def text: type == "string" and test("\\S");
def texts: type == "array" and all(.[]; text);
if .demo == false and (.why | text) then { demo, why }
elif .demo == true and (.setup | texts) and (.["ready-check"] | text) and (.["look-at"] | texts and length > 0)
     and (.view | type == "object" and (
           (.with == "browser" and (.address | text))
           or (.with == "terminal" and (.commands | texts and length > 0))
           or (.with == "other" and (.how | text))))
then { demo, setup, "ready-check", view: (.view | { with } + if .with == "browser" then { address } elif .with == "terminal" then { commands } else { how } end), "look-at" }
else null end
