import type { Tool } from "@modelcontextprotocol/sdk/types.js";
type InputSchema = Tool["inputSchema"];
export interface ToolContract {
    name: string;
    description: string;
    luaHandler: string;
    inputSchema: InputSchema;
    annotations?: Tool["annotations"];
    outputSchema?: Tool["outputSchema"];
}
export declare function outputSchemaFor(name: string): Tool["outputSchema"] | undefined;
export declare const TOOLS_WITH_OUTPUT_SCHEMA: readonly string[];
export declare const READ_ONLY_TOOL_NAMES: readonly string[];
export declare const DESTRUCTIVE_TOOL_NAMES: readonly string[];
export declare const MUTATING_TOOL_NAMES: readonly string[];
export declare function annotationsFor(name: string): Tool["annotations"];
export declare const POINT_CURVE_SETTING_KEYS: readonly ["ToneCurvePV2012", "ToneCurvePV2012Red", "ToneCurvePV2012Green", "ToneCurvePV2012Blue"];
export declare const DEVELOP_SETTING_KEYS: readonly ["WhiteBalance", "Temperature", "Tint", "Exposure2012", "Contrast2012", "Highlights2012", "Shadows2012", "Whites2012", "Blacks2012", "Texture", "Clarity2012", "Dehaze", "Vibrance", "Saturation", "SaturationAdjustmentRed", "SaturationAdjustmentOrange", "SaturationAdjustmentYellow", "SaturationAdjustmentGreen", "SaturationAdjustmentAqua", "SaturationAdjustmentBlue", "SaturationAdjustmentPurple", "SaturationAdjustmentMagenta", "HueAdjustmentRed", "HueAdjustmentOrange", "HueAdjustmentYellow", "HueAdjustmentGreen", "HueAdjustmentAqua", "HueAdjustmentBlue", "HueAdjustmentPurple", "HueAdjustmentMagenta", "LuminanceAdjustmentRed", "LuminanceAdjustmentOrange", "LuminanceAdjustmentYellow", "LuminanceAdjustmentGreen", "LuminanceAdjustmentAqua", "LuminanceAdjustmentBlue", "LuminanceAdjustmentPurple", "LuminanceAdjustmentMagenta", "ParametricShadows", "ParametricDarks", "ParametricLights", "ParametricHighlights", "ParametricShadowSplit", "ParametricMidtoneSplit", "ParametricHighlightSplit", "ToneCurvePV2012", "ToneCurvePV2012Red", "ToneCurvePV2012Green", "ToneCurvePV2012Blue", "ToneCurveName2012", "ConvertToGrayscale", "Sharpness", "SharpenRadius", "SharpenDetail", "SharpenEdgeMasking", "LuminanceSmoothing", "LuminanceNoiseReductionDetail", "LuminanceNoiseReductionContrast", "ColorNoiseReduction", "ColorNoiseReductionDetail", "ColorNoiseReductionSmoothness", "LensProfileEnable", "LensManualDistortionAmount", "PerspectiveVertical", "PerspectiveHorizontal", "PerspectiveRotate", "PerspectiveScale", "PerspectiveAspect", "PerspectiveUpright", "PostCropVignetteAmount", "PostCropVignetteMidpoint", "PostCropVignetteRoundness", "PostCropVignetteFeather", "PostCropVignetteStyle", "GrainAmount", "GrainSize", "GrainFrequency", "CropTop", "CropLeft", "CropBottom", "CropRight", "CropAngle"];
export declare const TOOL_CONTRACTS: ToolContract[];
export {};
//# sourceMappingURL=tool-contracts.d.ts.map