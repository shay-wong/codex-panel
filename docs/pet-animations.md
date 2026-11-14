# Import pet animations

[Capability index](fork-capabilities.md#imported-pet-animations) · [README](../README.md) · [简体中文入口](../README.zh-CN.md)

In Codex Panel, open **Preferences → 宠物动画 → 导入动画资源** and select a JSON manifest. Place its PNG or static WebP sprite sheet in the same folder. Panel copies the resources into its data directory, so moving the original files afterward does not break the import.

Each pack applies to the existing pet identified by `petId`; importing a pack does not create or select a pet. Import again with the same ID to replace its animations. Choose **移除** beside a pack to restore the pet's native animations. Source files and Codex application files are left intact.

Keep Panel connected. Both the main-window pet and floating pet apply changes during the next polling cycle, normally within two seconds. Installing or updating the native adapter can reload the renderer once; changing imported animation data does not require a full client reload.

## Pack format

The following example uses an eight-column, four-row sheet named `spritesheet.webp`. Every cell must have equal dimensions. Cell indices start at zero in the top-left corner, continue across each row, then continue on the next row. For example, cell `8` is the first cell of the second row.

```json
{
  "version": 1,
  "name": "My pet animations",
  "petId": "YOUR_EXISTING_PET_ID",
  "spritesheet": "spritesheet.webp",
  "columns": 8,
  "rows": 4,
  "animations": {
    "idle": {
      "frames": [[0, 1000], [1, 150], [2, 1000]],
      "loop": true
    },
    "jumping": {
      "frames": [[8, 500], [9, 100], [10, 500]],
      "loop": false
    }
  },
  "lookFrames": [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
}
```

Each frame is `[cellIndex, durationInMilliseconds]`. There is no fixed animation duration. A non-looping sequence finishes once and then uses this pack's `idle` frames. A looping sequence repeats; native previews that explicitly request looping also repeat. Pointer leave or another native state change cancels the previous sequence. Reduced-motion settings show its first frame.

`idle` is required and defaults to `loop: true`. Other states default to `loop: false`. Include the states needed by the pet:

| Key | Native use |
| --- | --- |
| `idle` | Resting, breathing and blinking |
| `running-right`, `running-left` | Movement while dragging |
| `waving` | Initial wake-up or greeting |
| `jumping` | Pointer hover or the native jumping state |
| `failed` | Failed operation |
| `waiting` | Waiting for approval or input |
| `running` | Working or thinking |
| `review` | Completed work awaiting attention |

`lookFrames` is optional. When supplied, it must contain exactly 16 cell indices in clockwise order: up, up-right intermediates, right, down-right intermediates, down, down-left intermediates, left, and up-left intermediates, in 22.5-degree steps. The pointer's neutral position uses the normal state rather than a seventeenth direction.

Missing states or look directions use the original pet resources. To keep the face, outfit and proportions consistent across every event, include all nine states and all 16 look directions in the same pack. The example above defines only resting, hover and look poses; add the other states for full coverage.

## Resource requirements

- `version` must be `1`. `petId` and `name` must be nonempty strings, each at most 240 characters.
- `spritesheet` must be a simple `.png` or `.webp` filename beside the manifest. Absolute paths, URLs, parent-directory paths and links to outside files are rejected.
- `columns` and `rows` must each be integers from 1 to 64. Image width and height must divide evenly by these values.
- A frame index must exist in the grid. Each duration must be an integer from 1 to 60,000 milliseconds; a pack may contain up to 10,000 animation frames.
- The selected JSON is limited to 1 MiB and the image to 32 MiB. Images are limited to 16,384 pixels per edge and 64 megapixels. Animated WebP is not accepted.

Import checks manifest fields, file boundaries, image format headers and dimensions. The renderer decodes the actual pixels. Use a transparent background for a clean desktop cutout. JSON describes data only; packages do not execute scripts, play audio or access a microphone.

The current native adapter was checked against Codex **26.1106.51428 / build 26605**. A different desktop build may require an adapter update. Unsupported native structures keep the original playback and report an error in the Panel log.
