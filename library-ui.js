const list = document.querySelector("#activity-list");

if (list) {
  decorateRows();

  // app.js replaces the activity rows as direct children of this container.
  // Observe only those replacements. Watching the full subtree would make our
  // own link-text and button updates recursively trigger this observer.
  const observer = new MutationObserver(() => decorateRows());
  observer.observe(list, { childList: true });

  list.addEventListener("click", (event) => {
    const row = event.target.closest(".activity-card");
    if (!row) return;

    if (event.target.closest("[data-edit-chat]")) {
      toggleRow(row, true);
      return;
    }

    if (event.target.closest("a, button, input, label")) return;
    toggleRow(row);
  });

  list.addEventListener("keydown", (event) => {
    if (event.target.closest("a, button, input")) return;
    const row = event.target.closest(".activity-card");
    if (!row || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    toggleRow(row);
  });
}

function decorateRows() {
  for (const row of list.querySelectorAll(".activity-card:not([data-compact-decorated])")) {
    row.dataset.compactDecorated = "true";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-expanded", row.classList.contains("expanded") ? "true" : "false");
    row.title = "Click to edit the ChatGPT review link";

    const links = row.querySelector(".activity-links");
    if (!links) continue;

    let hasChatLink = false;
    for (const link of links.querySelectorAll("a")) {
      const href = link.getAttribute("href") || "";
      const isChat = href.includes("chatgpt.com") || href.includes("chat.openai.com");
      link.textContent = isChat ? "ChatGPT" : "Drive";
      hasChatLink ||= isChat;
    }

    if (!hasChatLink) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-link";
      button.dataset.editChat = "";
      button.textContent = "ChatGPT";
      button.title = "Add ChatGPT conversation link";
      links.append(button);
    }
  }
}

function toggleRow(row, forceOpen = false) {
  const expanded = forceOpen || !row.classList.contains("expanded");
  row.classList.toggle("expanded", expanded);
  row.setAttribute("aria-expanded", String(expanded));
  if (expanded) row.querySelector("[data-chat-url]")?.focus();
}
