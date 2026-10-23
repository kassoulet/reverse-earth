import {
  buildSearchResults,
  loadPlaces,
  type Place,
  type SearchResult,
} from "./search";

export interface SearchControlOptions {
  form: HTMLFormElement;
  input: HTMLInputElement;
  list: HTMLUListElement;
  status: HTMLElement;
  onSelect: (result: SearchResult) => void;
}

const SEARCH_DELAY_MS = 120;

/**
 * Combobox behaviour for coordinate and place search. The Natural Earth index
 * is fetched on first use, never on page load, and the UI degrades to
 * coordinate-only search if it cannot be loaded.
 */
export class SearchControl {
  readonly #options: SearchControlOptions;
  #places: readonly Place[] = [];
  #results: SearchResult[] = [];
  #activeIndex = -1;
  #enabled = false;
  #loadStarted = false;
  #loading = false;
  #loadFailed = false;
  #timer: number | undefined;

  constructor(options: SearchControlOptions) {
    this.#options = options;
    const { form, input, list } = options;

    input.addEventListener("input", () => {
      this.#scheduleSearch();
    });
    input.addEventListener("focus", () => {
      this.#ensurePlaces();
      if (input.value.trim()) this.#runSearch();
    });
    input.addEventListener("keydown", (event) => {
      this.#handleKey(event);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#commit();
    });
    list.addEventListener("pointerdown", (event) => {
      // Keep focus on the input so the click does not close the list first.
      event.preventDefault();
    });
    document.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Node && !form.contains(event.target)) {
        this.#close();
      }
    });
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    this.#options.input.disabled = !enabled;
    if (!enabled) this.#close();
  }

  #scheduleSearch(): void {
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      this.#timer = undefined;
      this.#runSearch();
    }, SEARCH_DELAY_MS);
  }

  #ensurePlaces(): void {
    if (this.#loadStarted || !this.#enabled) return;
    this.#loadStarted = true;
    this.#loading = true;

    loadPlaces()
      .then((places) => {
        this.#places = places;
        this.#loading = false;
        if (this.#options.input.value.trim()) this.#runSearch();
      })
      .catch((error: unknown) => {
        console.error(error);
        this.#loading = false;
        this.#loadFailed = true;
        this.#runSearch();
      });
  }

  #runSearch(): void {
    if (!this.#enabled) return;
    this.#ensurePlaces();

    const query = this.#options.input.value.trim();
    this.#activeIndex = -1;

    if (!query) {
      this.#results = [];
      this.#close();
      return;
    }

    const results = buildSearchResults(query, this.#places);
    this.#results = results;

    if (results.length === 0) {
      this.#renderList();
      if (this.#loading) this.#setStatus("Loading places…");
      else if (this.#loadFailed)
        this.#setStatus("Place search is unavailable. Coordinates still work.");
      else this.#setStatus("No matching place. Try a city, or 48.85, 2.35.");
      return;
    }

    this.#renderList();
  }

  #renderList(): void {
    const { input, list, status } = this.#options;
    list.replaceChildren();

    if (this.#results.length === 0) {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      return;
    }

    for (const [index, result] of this.#results.entries()) {
      const item = document.createElement("li");
      item.className = "search__result";
      item.id = `search-result-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === this.#activeIndex ? "true" : "false");

      const title = document.createElement("span");
      title.className = "search__result-title";
      title.textContent = result.title;

      const detail = document.createElement("span");
      detail.className = "search__result-detail";
      detail.textContent = result.detail;

      item.append(title, detail);
      item.addEventListener("click", () => {
        this.#choose(index);
      });
      item.addEventListener("pointermove", () => {
        this.#setActive(index, false);
      });
      list.append(item);
    }

    status.hidden = true;
    status.textContent = "";
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    this.#syncActiveDescendant();
  }

  #handleKey(event: KeyboardEvent): void {
    const count = this.#results.length;

    if (event.key === "ArrowDown") {
      if (count === 0) return;
      event.preventDefault();
      this.#setActive((this.#activeIndex + 1) % count);
    } else if (event.key === "ArrowUp") {
      if (count === 0) return;
      event.preventDefault();
      this.#setActive(this.#activeIndex <= 0 ? count - 1 : this.#activeIndex - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.#commit();
    } else if (event.key === "Escape") {
      this.#close();
      this.#options.input.blur();
    }
  }

  #commit(): void {
    if (!this.#enabled) return;
    // Typing may still be debounced, so refresh before choosing; remember the
    // highlighted row first because #runSearch resets it.
    const activeIndex = this.#activeIndex;
    this.#runSearch();
    if (this.#results.length === 0) return;
    this.#choose(activeIndex >= 0 && activeIndex < this.#results.length ? activeIndex : 0);
  }

  #setActive(index: number, scroll = true): void {
    if (index === this.#activeIndex) return;
    this.#activeIndex = index;
    this.#syncActiveDescendant();
    const items = this.#options.list.querySelectorAll<HTMLElement>(".search__result");
    items.forEach((item, itemIndex) => {
      item.setAttribute("aria-selected", itemIndex === index ? "true" : "false");
    });
    if (scroll) items[index]?.scrollIntoView({ block: "nearest" });
  }

  #syncActiveDescendant(): void {
    if (this.#activeIndex >= 0) {
      this.#options.input.setAttribute(
        "aria-activedescendant",
        `search-result-${this.#activeIndex}`,
      );
    } else {
      this.#options.input.removeAttribute("aria-activedescendant");
    }
  }

  #choose(index: number): void {
    const result = this.#results[index];
    if (!result) return;
    this.#options.input.value = result.title;
    this.#close();
    this.#options.input.blur();
    this.#options.onSelect(result);
  }

  #close(): void {
    if (this.#timer !== undefined) {
      window.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#activeIndex = -1;
    this.#results = [];
    this.#options.list.hidden = true;
    this.#options.list.replaceChildren();
    this.#options.input.setAttribute("aria-expanded", "false");
    this.#options.input.removeAttribute("aria-activedescendant");
    this.#setStatus("");
  }

  #setStatus(message: string): void {
    const { status } = this.#options;
    status.textContent = message;
    status.hidden = message.length === 0;
  }
}
