{
  "name": __NAME_JSON__,
  "template": "http",
  "capabilities": ["net:fetch"],
  "outputSchema": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "url": { "type": "string" },
            "date": { "type": "string" }
          }
        }
      }
    }
  }
}
