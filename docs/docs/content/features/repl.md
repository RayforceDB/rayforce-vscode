# Interactive REPL

The RayforceDB VS Code Extension includes a fully integrated REPL (Read-Eval-Print Loop) panel that makes it easy to interact with your RayforceDB instances.

## Accessing the REPL

The REPL can be accessed in several ways:

- Click the **Open REPL** button from the Instance Manager
- Use the command palette: `Rayforce: Open REPL`
- Execute selected code directly from your `.rfl` or `.rf` files

IMAGE HERE

## Features

### Easy Command Execution

Simply type your Rayfall commands in the REPL input area and press Enter to execute them. The REPL provides immediate feedback with formatted output.

IMAGE HERE

### Autocomplete Support

The REPL includes intelligent autocomplete that suggests:

- Built-in Rayfall functions
- Keywords and special forms
- Type names and constants
- Environment variables

Just start typing and get helpful suggestions as you code.

IMAGE HERE

### Environment Variable Inspection

Easily inspect environment variables in your connected instance. The REPL provides access to all defined variables, making it simple to explore and understand your RayforceDB environment.

IMAGE HERE

### Formatted Output

The REPL displays results in a beautifully formatted way:

- Tables are rendered with proper alignment
- Lists and dictionaries are clearly structured
- Error messages are highlighted for easy identification
- Large results support pagination

IMAGE HERE

## Connection Status

The REPL shows your current connection status in the panel title, displaying the host and port of the connected instance. When disconnected, you can easily connect to any available instance from the Instance Manager.

