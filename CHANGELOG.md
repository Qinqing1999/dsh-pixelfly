# Changelog

## 0.2.0

The studio is now one workspace with a version tree instead of a library of records, and it covers
the full editing surface rather than only drawing new pictures.

- **One workspace, one history.** Every run is a version whose parent is the picture it was made
  from, so the tree shows how a picture evolved. Any version can be reopened, starred, compared or
  deleted; the workspace is one file.
- **New operations:** regional repaint, remove element, extract asset, remove background, outpaint,
  enhance, remove watermark, edit text, colour and line art, reference fusion, batch by prompt list
  or by `[variable]` matrix, and prompt distillation.
- **Start from a picture you already have.** Uploading drops the file into the history as the root
  version, so every edit can begin from it instead of only from a generated picture.
- **Pick among the candidates.** A run that returns several pictures keeps all of them in one
  version; thumbnails under the canvas choose which one is shown and which one the next edit
  continues from.
- **Only the operations that can run.** The operation list is built from the catalogue and hides the
  ones whose source picture or vision model is missing, instead of offering a button that fails.
- **A vision-model planner.** Repaints, watermark location, subject naming for cutouts and text
  recognition are planned by a chat model that looks at the picture, with the user's own words as a
  fallback when none is configured.
- **Seamless regional edits.** A padded crop is sent so the model has real surroundings to continue;
  only the part of the answer that lines up with the selection is pasted back, its colour is
  corrected against the border ring, and it is feathered in with a smoothstep ramp.
- **Background removal that always answers.** When the model returns an opaque "cutout", a flood-fill
  from the picture edges produces the transparency instead of failing the operation.
- **Batch and comparison** in the UI: run many prompts at once, and compare any two versions side by
  side or with a slider.
- **Vision over three protocols.** The vision model can be reached through Chat Completions,
  Anthropic Messages or the Responses API, chosen in the settings page, for upstreams that do not
  expose an OpenAI-compatible chat endpoint. Grok joins the provider list.
- **Library entries can carry a picture**, so a saved prompt can show the result it came from.
- **Chinese and English** on both the settings page and the studio.

### Fixed

- Reading a prompt back records a version with no picture of its own, which blanked the studio and
  made the next edit fail. The canvas and the source lookup now walk up to the nearest ancestor that
  has a picture.
- Text recognition ran again for every keystroke; the answer is now cached per picture and per vision
  model, so a second "find the text" is instant.
- The version tree crashed the whole panel because it called the operation-label helper without
  binding it, leaving the tab empty.
- A vision model's answer was read from the wrong envelope, so every vision-dependent operation
  reported "the model did not answer with JSON".
- A well-formed "this does not apply" verdict was retried as if it were a malformed reply, hiding the
  real reason.
- An empty model selection was treated as a chosen model, so the configured vision default was never
  used.
- The result chips read attempts and key from the wrong place, and the drag selection never reached
  the panel that displays it.

### Removed

- **Import and export.** There is no zip round-trip, no "save to a folder" setting and no output
  directory to configure. Pictures live in the content-addressed asset store and are fetched from
  the Host on demand; a single picture still downloads from the version card.
- **The project concept.** No project list, no create/rename/duplicate/archive, no per-project
  folders on disk. The plugin opens on one workspace with one history.
- **The conversation log.** Every run used to append a chat line to the workspace file that nothing
  ever rendered. The version tree is the history; the file now holds only that.

## 0.1.0

First release: settings page for the upstream and a multi-key ring, exponential backoff with jitter,
a studio page for text-to-image, and three agent tools.
