// web/src/fonts-list.ts — curated Google Fonts family names for the panel's
// datalist picker (spec §7.5 "searchable picker"; §8 scopes fonts to Google
// Fonts). Free-text entry still works for any family not listed — the value
// goes verbatim into the css2 URL, so anything Google serves is usable.
// Weighted toward book work: text serifs and display faces first-class.
export const GOOGLE_FONTS: string[] = [
  "Abril Fatface", "Alegreya", "Alegreya Sans", "Amatic SC",
  "Architects Daughter", "Arvo", "Baskervville", "Bellefair", "Bitter",
  "Bodoni Moda", "Cabin", "Cardo", "Caveat", "Cinzel", "Cinzel Decorative",
  "Cormorant", "Cormorant Garamond", "Courier Prime", "Crimson Pro",
  "Crimson Text", "DM Sans", "DM Serif Display", "DM Serif Text",
  "Dancing Script", "EB Garamond", "Eczar", "Faustina", "Fira Code",
  "Fira Sans", "Forum", "Fraunces", "Gelasio", "Gentium Book Plus",
  "Gentium Plus", "Goudy Bookletter 1911", "Great Vibes", "Halant",
  "Homemade Apple", "IBM Plex Mono", "IBM Plex Sans", "IBM Plex Serif",
  "IM Fell English", "Inconsolata", "Inter", "JetBrains Mono", "Josefin Sans",
  "Josefin Slab", "Kalam", "Karla", "Lato", "Libre Baskerville",
  "Libre Caslon Text", "Literata", "Lora", "Manrope", "Marcellus",
  "Merriweather", "Montserrat", "Mulish", "Neuton", "Newsreader", "Noto Sans",
  "Noto Serif", "Nunito", "Nunito Sans", "Old Standard TT", "Open Sans",
  "Oswald", "PT Sans", "PT Serif", "Parisienne", "Patrick Hand", "Petrona",
  "Philosopher", "Playfair Display", "Poppins", "Prata", "Quicksand",
  "Raleway", "Roboto", "Roboto Condensed", "Roboto Mono", "Roboto Slab",
  "Rubik", "Sacramento", "Shadows Into Light", "Sorts Mill Goudy",
  "Source Code Pro", "Source Sans 3", "Source Serif 4", "Space Grotesk",
  "Space Mono", "Special Elite", "Spectral", "Tangerine",
  "UnifrakturMaguntia", "Vollkorn", "Work Sans", "Zilla Slab",
];
