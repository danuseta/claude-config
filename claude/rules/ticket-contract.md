# Ticket contract rule

Applies to every session that builds or reviews a Jira ticket: the orchestrator cron, a DOCK chat, or a terminal session. Run it before reading the sprint blackboard and before writing any code or finding.

Operations below are named by what they do (fetch an issue, search pages, fetch a page). Use whichever Atlassian MCP the machine has; tool name prefixes differ between the claude.ai connector and the `atlassian` MCP server.

## 1. Find the contract, in this order

1. The ticket's own fields: description, Acceptance Criteria (`customfield_10332`), Problem Definition, and comments. Collect every Confluence link and every document named in the text ("Friday contract", "RFC 022", "working contract").
2. The parent ticket (epic), read the same way.
3. The remote links of the ticket and of the epic.
4. A Confluence page search: `type = page AND text ~ "<KEY>"`, then `type = page AND text ~ "<EPIC KEY>"`, both ordered `lastmodified DESC`. Keep the pages whose title or body says it is the contract, an RFC, or the working contract for that ticket or epic.

No hardcoded map of tickets to pages. Search every time.

## 2. Read it

1. Fetch each candidate page. Record its id, title, version, and last-modified date.
2. When more than one contract applies, the newer one that is more specific to the ticket wins. Write down which one was chosen and why.

## 3. When nothing is found

Continue without a contract only when the ticket names no contract and every search in step 1 came back empty. Record the searches that were tried, and put this line in the PR body:

`Contract: not found (searched: <list>)`

## 4. When a contract is found but cannot be read

The MCP is not logged in, or the fetch returns 401, 404, or a timeout: stop. Do not write code. Report the page and the reason in the chat.

## 5. Design artifacts

A `claude.ai/artifact/<id>` link in the ticket, the epic, a comment or a remote link (storyboard, wireframe, sprint plan) is a design source the change must follow, with or without a Confluence contract. It is never skipped as "not Confluence".

1. List every such link with where it was named.
2. Read each one from a saved copy: `<board>/materials/artifacts/<id>.html`, or an HTML file the owner attached in the chat (copy it there first). The copy is one self-contained HTML file: its screens, labels and sample data sit in the source, so search it for the ticket's terms and read those parts, or open it from `file://` in a browser where that is allowed.
3. A machine with the Artifact tool (the laptop) reads the link itself and saves the HTML there. The workspace cannot: WebFetch gets an empty shell and the browser gets a Cloudflare check.
4. A link with no copy: stop before planning, like an unreadable contract. Ask the owner for the HTML of that link, named in the question, and say how: open it in Claude Code on the laptop, then attach the saved HTML in the chat.

## 6. Evidence

- The PR body carries `Contract: Confluence <id> "<title>" v<version>` and quotes the contract sentences the change relies on.
- The PR body carries `Design: <artifact link>` for every artifact the change follows.
- When the sprint blackboard disagrees with the contract, the contract wins. Record the difference with `status.cjs decide <KEY> "<what and why>"`.

## Check

- [ ] Ticket fields, epic, remote links, and both page searches were tried, in that order
- [ ] Page id, title, version, and last-modified date are recorded
- [ ] An unreadable contract stopped the session
- [ ] Every artifact link was read from a saved copy, or the session stopped and asked for it
- [ ] The PR body has the `Contract:` line and a `Design:` line per artifact
