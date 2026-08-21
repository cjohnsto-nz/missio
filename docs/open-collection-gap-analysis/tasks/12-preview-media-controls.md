# OC-120 Preview Media Zoom And Rotate Controls

## Goal

Add first-class zoom and rotate controls for image and PDF responses in the request preview pane. Users should be able to inspect binary preview content with familiar viewer behavior instead of relying on the browser/webview default scale.

## Current Gap

Missio can preview images and PDFs, but the preview pane does not expose media-viewer controls. Large images and PDFs are hard to inspect, and users cannot use expected gestures like Ctrl+scroll to zoom preview content.

| Surface | Gap |
| --- | --- |
| Image preview | No zoom, rotate, reset, fit, or keyboard/mouse control for rendered images. |
| PDF preview | PDF pages render, but users cannot zoom or rotate pages from the preview UI. |
| Mouse behavior | Ctrl+scroll inside the preview pane does not zoom the previewed image/PDF. |
| UI affordance | There is no compact preview toolbar; use the existing Ctrl+F find panel as the local UX reference. |
| State management | Preview transform state must reset predictably for each new response and not leak across content types. |

## Implementation Plan

1. Audit the response preview implementation:

| Area | Work |
| --- | --- |
| Response rendering | Review `src/webview/response.ts`, especially image and PDF branches in `renderPreview()`. |
| Request panel shell | Review `src/webview/requestPanel.ts` and `src/webview/requestPanel.css` for the Ctrl+F find panel layout, animation, focus handling, and compact toolbar conventions. |
| PDF.js integration | Confirm PDF scale changes re-render pages cleanly and do not leave stale canvases, blob URLs, or worker errors. |
| Existing tests | Review webview/source tests such as `test/requestTypeUx.test.ts` and response/provider tests for the current test style. |

2. Design the preview media controls:

| Need | Expected Behavior |
| --- | --- |
| Toolbar | Add a small preview media control panel, visually aligned with the Ctrl+F find panel style, visible only for image/PDF preview content. |
| Zoom controls | Include zoom in, zoom out, reset to 100%, and a readable zoom percentage. |
| Fit controls | Include fit-to-width or fit-to-page behavior where practical; use clear state and avoid layout jumps. |
| Rotate controls | Include rotate left and rotate right in 90-degree increments for both image and PDF previews. |
| Pointer gesture | Ctrl+scroll inside the preview pane zooms the current image/PDF content and prevents accidental page/webview scrolling while the gesture is active. |
| Bounds | Clamp zoom to sensible limits, such as 25% to 500%, with stable increments. |
| Reset | New responses and non-media previews reset media transform state and hide the media control panel. |

3. Implement image behavior:

| Requirement | Behavior |
| --- | --- |
| Image scaling | Render images in a stable preview container that applies zoom and rotation without distorting aspect ratio. |
| Rotation | Rotate around the content center and keep the transformed image inspectable, not clipped by a fixed-size parent. |
| Scroll/pan | When zoomed beyond the viewport, users can scroll the preview area to inspect content. |
| Non-SVG and SVG | Cover base64 image responses and existing SVG/text fallback behavior without breaking HTML preview rendering. |

4. Implement PDF behavior:

| Requirement | Behavior |
| --- | --- |
| PDF zoom | Re-render PDF pages at the selected zoom instead of only applying CSS scale to canvases if CSS scaling makes output blurry. |
| PDF rotation | Apply rotation consistently to every rendered page. |
| Render cancellation | Prevent stale async page renders from appending canvases after a newer zoom/rotate/new-response render starts. |
| Performance | Avoid excessive re-rendering during Ctrl+scroll; debounce or coalesce rapid wheel events where needed. |

5. Preserve preview/editor safety:

| Requirement | Behavior |
| --- | --- |
| Scope | Controls affect only the Preview tab's rendered image/PDF content. They must not mutate request YAML or response data. |
| Accessibility | Buttons have labels/tooltips, keyboard focus order is usable, and visible text fits in compact controls. |
| Theme | Use VS Code theme tokens and existing Missio control styles. |
| Protocol neutrality | Works for HTTP, GraphQL, WebSocket, and gRPC responses if their response bodies carry image/PDF content. |

## Dependencies

| Task | Impact |
| --- | --- |
| OC-040/OC-080/OC-090 | Response shapes may come from HTTP and supported non-HTTP runtimes; do not assume HTTP-only response metadata. |
| OC-070 | Import/export and response tooling should not be changed by this visual-only task. |
| OC-100/OC-110 | Keep the preview panel UI consistent with the current request editor shell and compact panel patterns. |
| Release PDF.js fix | Build/packaging must continue to include PDF.js assets and the preview controls must not regress packaged PDF preview behavior. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Image controls | Image previews support zoom in/out, reset, fit, rotate left/right, and Ctrl+scroll zoom. |
| PDF controls | PDF previews support zoom in/out, reset, fit where practical, rotate left/right, and Ctrl+scroll zoom. |
| UI panel | A compact preview media control panel appears only for image/PDF preview content and follows the Ctrl+F find panel as the local style reference. |
| State reset | New responses, non-media previews, and clear-response flows hide controls and reset zoom/rotation. |
| Render safety | Rapid PDF zoom/rotate changes cannot leave stale canvases or mixed-scale pages. |
| Packaging | `npm run build` and VSIX packaging still include PDF.js assets needed by PDF preview. |
| Tests | Complete automated tests cover transform state, control visibility, Ctrl+wheel behavior, image/PDF branches, reset behavior, and PDF stale-render protection. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Pure transform helper tests. | Zoom clamps to min/max, increments/decrements correctly, reset returns 100%/0 degrees, rotation normalizes to 0/90/180/270. |
| Image preview source test. | Image preview markup includes a media transform container and media control panel hooks without affecting HTML/text previews. |
| PDF render state test. | A newer PDF render token prevents older async renders from appending canvases. |
| Ctrl+wheel handler test. | Ctrl+wheel inside the preview pane calls `preventDefault()`, updates zoom, and leaves ordinary wheel scrolling unchanged. |
| Visibility/reset test. | `showResponse`, `clearResponse`, and non-media `renderPreview` hide controls and reset transform state. |
| Packaging/build regression. | `npm run build` produces `media/pdf.min.mjs` and `media/pdf.worker.min.mjs`; VSIX package listing includes both assets. |

## Out Of Scope

| Area | Reason |
| --- | --- |
| Editing or annotating PDFs/images | This task covers viewing controls only. |
| Persisting zoom/rotation across sessions | Initial implementation should reset per response to avoid surprising state carryover. |
| Browser-wide zoom | Ctrl+scroll should affect the previewed media content, not VS Code or webview zoom. |
| Advanced PDF navigation | Page thumbnails, page jump, search within PDF, and text selection are separate viewer features. |
