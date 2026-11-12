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
- **Chinese and English** on both the settings page and the studio.

### Fixed

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

## 0.1.0

First release: settings page for the upstream and a multi-key ring, exponential backoff with jitter,
a studio page for text-to-image, and three agent tools.
