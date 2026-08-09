// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildFunctionPrompt, parseFunctionResponse, type FunctionResponse, type FunctionTool } from "../src/daemon/tool-protocol";

const weatherTool: FunctionTool = {
  type: "function",
  name: "get_weather",
  description: "Get the current weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false
  },
  strict: true
};

describe("function tool prompt protocol", (): void => {
  it("places tool definitions and untrusted input in a strict prompt envelope", (): void => {
    const prompt: string = buildFunctionPrompt({ text: "Weather in Paris?", tool_outputs: [] }, [weatherTool], "auto", true, undefined);

    expect(prompt).toContain('"name":"get_weather"');
    expect(prompt).toContain('"text":"Weather in Paris?"');
    expect(prompt).toContain("WEB2API_FUNCTION_CALLS_V1");
    expect(prompt).not.toContain("<web2api_function_calls>");
    expect(prompt).toContain("The API client executes selected functions");
    expect(prompt).toContain("Multiple function calls are allowed");
  });

  it("parses one or more function calls into Responses arguments strings", (): void => {
    const result: FunctionResponse = parseFunctionResponse(
      'WEB2API_FUNCTION_CALLS_V1\n{"calls":[{"call_id":"call_weather","name":"get_weather","arguments":{"city":"Paris"}}]}\nWEB2API_FUNCTION_CALLS_END',
      [weatherTool]
    );

    expect(result).toEqual({
      type: "function_calls",
      calls: [{ callId: "call_weather", name: "get_weather", arguments: '{"city":"Paris"}' }]
    });
  });

  it("keeps ordinary assistant output as text", (): void => {
    expect(parseFunctionResponse("No tool is needed.", [weatherTool])).toEqual({ type: "text", text: "No tool is needed." });
  });

  it("rejects protocol output that calls an undeclared function", (): void => {
    expect((): void => {
      parseFunctionResponse(
        'WEB2API_FUNCTION_CALLS_V1\n{"calls":[{"call_id":"call_bad","name":"delete_everything","arguments":{}}]}\nWEB2API_FUNCTION_CALLS_END',
        [weatherTool]
      );
    }).toThrow("undeclared function");
  });

  it("rejects protocol tags surrounded by assistant commentary", (): void => {
    expect((): void => {
      parseFunctionResponse(
        'I will call it now. WEB2API_FUNCTION_CALLS_V1\n{"calls":[{"call_id":"call_weather","name":"get_weather","arguments":{"city":"Paris"}}]}\nWEB2API_FUNCTION_CALLS_END',
        [weatherTool]
      );
    }).toThrow("Malformed function call protocol response");
  });

  it("rejects text when a function call is required", (): void => {
    expect((): void => {
      parseFunctionResponse("I cannot call a function.", [weatherTool], "required", true);
    }).toThrow("required");
  });

  it("rejects a call to a different function than the forced choice", (): void => {
    const timeTool: FunctionTool = {
      type: "function",
      name: "get_time",
      parameters: { type: "object", properties: {} },
      strict: true
    };

    expect((): void => {
      parseFunctionResponse(
        'WEB2API_FUNCTION_CALLS_V1\n{"calls":[{"call_id":"call_weather","name":"get_weather","arguments":{"city":"Paris"}}]}\nWEB2API_FUNCTION_CALLS_END',
        [weatherTool, timeTool],
        { name: "get_time" },
        true
      );
    }).toThrow("forced function");
  });

  it("rejects multiple calls when parallel calls are disabled", (): void => {
    expect((): void => {
      parseFunctionResponse(
        'WEB2API_FUNCTION_CALLS_V1\n{"calls":[{"call_id":"call_paris","name":"get_weather","arguments":{"city":"Paris"}},{"call_id":"call_london","name":"get_weather","arguments":{"city":"London"}}]}\nWEB2API_FUNCTION_CALLS_END',
        [weatherTool],
        "auto",
        false
      );
    }).toThrow("parallel_tool_calls");
  });
});
