/**
 * Antfarm palette owned by the theme layer. Surfaces, text and primary actions keep the
 * neutral built-in tokens; Antfarm adds one sand accent for its brand mark, links, the send
 * button, sandbox status and the visitor workbench, plus the soil tones of the sign-in illustration.
 */
export const ANTFARM_PALETTE = `
html body {
 --af-sand:#a35f0b;
 --af-sand-tint:#f8eedd;
 --af-soil-1:#f4ead9;
 --af-soil-2:#ecdcc2;
 --af-soil-3:#e2cba7;
 --af-chamber:#fdfaf4;
 --af-ant:#3a2914;
 --dsw-alias-link:#9a5a0a;
 --dsw-alias-button-info-fill:#a35f0b;
 --dsw-alias-button-info-hover:#8a4f08;
}
html body[data-ds-dark-theme] {
 --af-sand:#f0b45e;
 --af-sand-tint:#2c2417;
 --af-soil-1:#221d16;
 --af-soil-2:#28221a;
 --af-soil-3:#30291e;
 --af-chamber:#17161a;
 --af-ant:#f2d2a0;
 --dsw-alias-link:#f0b45e;
 --dsw-alias-button-info-fill:#c27a17;
 --dsw-alias-button-info-hover:#d38b27;
}
`
