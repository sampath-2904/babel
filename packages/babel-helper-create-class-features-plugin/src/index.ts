import { types as t } from "@babel/core";
import type { File, PluginAPI, PluginObject } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import nameFunction from "@babel/helper-function-name";
import splitExportDeclaration from "@babel/helper-split-export-declaration";
import {
  buildPrivateNamesNodes,
  buildPrivateNamesMap,
  transformPrivateNamesUsage,
  buildFieldsInitNodes,
} from "./fields";
import type { PropPath } from "./fields";
import { buildDecoratedClass, hasDecorators } from "./decorators";
import { injectInitialization, extractComputedKeys } from "./misc";
import { enableFeature, FEATURES, isLoose, shouldTransform } from "./features";
import { assertFieldTransformed } from "./typescript";

export { FEATURES, enableFeature, injectInitialization };

declare const PACKAGE_JSON: { name: string; version: string };

// Note: Versions are represented as an integer. e.g. 7.1.5 is represented
//       as 70000100005. This method is easier than using a semver-parsing
//       package, but it breaks if we release x.y.z where x, y or z are
//       greater than 99_999.
const version = PACKAGE_JSON.version
  .split(".")
  .reduce((v, x) => v * 1e5 + +x, 0);
const versionKey = "@babel/plugin-class-features/version";

interface Options {
  name: string;
  feature: number;
  loose?: boolean;
  inherits?: PluginObject["inherits"];
  manipulateOptions?: PluginObject["manipulateOptions"];
  api?: PluginAPI;
}

export function createClassFeaturePlugin({
  name,
  feature,
  loose,
  manipulateOptions,
  // @ts-ignore TODO(Babel 8): Remove the default value
  api = { assumption: () => void 0 },
  inherits,
}: Options) {
  const setPublicClassFields = api.assumption("setPublicClassFields");
  const privateFieldsAsProperties = api.assumption("privateFieldsAsProperties");
  const constantSuper = api.assumption("constantSuper");
  const noDocumentAll = api.assumption("noDocumentAll");

  if (loose === true) {
    const explicit = [];

    if (setPublicClassFields !== undefined) {
      explicit.push(`"setPublicClassFields"`);
    }
    if (privateFieldsAsProperties !== undefined) {
      explicit.push(`"privateFieldsAsProperties"`);
    }
    if (explicit.length !== 0) {
      console.warn(
        `[${name}]: You are using the "loose: true" option and you are` +
          ` explicitly setting a value for the ${explicit.join(" and ")}` +
          ` assumption${explicit.length > 1 ? "s" : ""}. The "loose" option` +
          ` can cause incompatibilities with the other class features` +
          ` plugins, so it's recommended that you replace it with the` +
          ` following top-level option:\n` +
          `\t"assumptions": {\n` +
          `\t\t"setPublicClassFields": true,\n` +
          `\t\t"privateFieldsAsProperties": true\n` +
          `\t}`,
      );
    }
  }

  return {
    name,
    manipulateOptions,
    inherits,

    pre() {
      enableFeature(this.file, feature, loose);

      if (!this.file.get(versionKey) || this.file.get(versionKey) < version) {
        this.file.set(versionKey, version);
      }
    },

    visitor: {
      Class(path: NodePath<t.Class>, state: File) {
        if (this.file.get(versionKey) !== version) return;

        if (!shouldTransform(path, this.file)) return;

        if (path.isClassDeclaration()) assertFieldTransformed(path);

        const loose = isLoose(this.file, feature);

        let constructor: NodePath<t.ClassMethod>;
        const isDecorated = hasDecorators(path.node);
        const props: PropPath[] = [];
        const elements = [];
        const computedPaths: NodePath<t.ClassProperty | t.ClassMethod>[] = [];
        const privateNames = new Set<string>();
        const body = path.get("body");

        for (const path of body.get("body")) {
          if (
            // check path.node.computed is enough, but ts will complain
            (path.isClassProperty() || path.isClassMethod()) &&
            path.node.computed
          ) {
            computedPaths.push(path);
          }

          if (path.isPrivate()) {
            const { name } = path.node.key.id;
            const getName = `get ${name}`;
            const setName = `set ${name}`;

            if (path.isClassPrivateMethod()) {
              if (path.node.kind === "get") {
                if (
                  privateNames.has(getName) ||
                  (privateNames.has(name) && !privateNames.has(setName))
                ) {
                  throw path.buildCodeFrameError("Duplicate private field");
                }
                privateNames.add(getName).add(name);
              } else if (path.node.kind === "set") {
                if (
                  privateNames.has(setName) ||
                  (privateNames.has(name) && !privateNames.has(getName))
                ) {
                  throw path.buildCodeFrameError("Duplicate private field");
                }
                privateNames.add(setName).add(name);
              }
            } else {
              if (
                (privateNames.has(name) &&
                  !privateNames.has(getName) &&
                  !privateNames.has(setName)) ||
                (privateNames.has(name) &&
                  (privateNames.has(getName) || privateNames.has(setName)))
              ) {
                throw path.buildCodeFrameError("Duplicate private field");
              }

              privateNames.add(name);
            }
          }

          if (path.isClassMethod({ kind: "constructor" })) {
            constructor = path;
          } else {
            elements.push(path);
            if (
              path.isProperty() ||
              path.isPrivate() ||
              path.isStaticBlock?.()
            ) {
              props.push(path as PropPath);
            }
          }
        }

        if (!props.length && !isDecorated) return;

        const innerBinding = path.node.id;
        let ref: t.Identifier;
        if (!innerBinding || path.isClassExpression()) {
          nameFunction(path);
          ref = path.scope.generateUidIdentifier("class");
        } else {
          ref = t.cloneNode(path.node.id);
        }

        // NODE: These three functions don't support decorators yet,
        //       but verifyUsedFeatures throws if there are both
        //       decorators and private fields.
        const privateNamesMap = buildPrivateNamesMap(props);
        const privateNamesNodes = buildPrivateNamesNodes(
          privateNamesMap,
          (privateFieldsAsProperties ?? loose) as boolean,
          state,
        );

        transformPrivateNamesUsage(
          ref,
          path,
          privateNamesMap,
          {
            privateFieldsAsProperties: privateFieldsAsProperties ?? loose,
            noDocumentAll,
            innerBinding,
          },
          state,
        );

        let keysNodes: t.Statement[],
          staticNodes: t.Statement[],
          instanceNodes: t.Statement[],
          pureStaticNodes: t.FunctionDeclaration[],
          wrapClass: (path: NodePath<t.Class>) => NodePath;

        if (isDecorated) {
          staticNodes = pureStaticNodes = keysNodes = [];
          ({ instanceNodes, wrapClass } = buildDecoratedClass(
            ref,
            path,
            elements,
            this.file,
          ));
        } else {
          keysNodes = extractComputedKeys(ref, path, computedPaths, this.file);
          ({ staticNodes, pureStaticNodes, instanceNodes, wrapClass } =
            buildFieldsInitNodes(
              ref,
              path.node.superClass,
              props,
              privateNamesMap,
              state,
              (setPublicClassFields ?? loose) as boolean,
              (privateFieldsAsProperties ?? loose) as boolean,
              (constantSuper ?? loose) as boolean,
              innerBinding,
            ));
        }

        if (instanceNodes.length > 0) {
          injectInitialization(
            path,
            constructor,
            instanceNodes,
            (referenceVisitor, state) => {
              if (isDecorated) return;
              for (const prop of props) {
                // @ts-expect-error: TS doesn't infer that prop.node is not a StaticBlock
                if (t.isStaticBlock?.(prop.node) || prop.node.static) continue;
                prop.traverse(referenceVisitor, state);
              }
            },
          );
        }

        // rename to make ts happy
        const wrappedPath = wrapClass(path);
        wrappedPath.insertBefore([...privateNamesNodes, ...keysNodes]);
        if (staticNodes.length > 0) {
          wrappedPath.insertAfter(staticNodes);
        }
        if (pureStaticNodes.length > 0) {
          wrappedPath
            .find(parent => parent.isStatement() || parent.isDeclaration())
            .insertAfter(pureStaticNodes);
        }
      },

      ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
        if (this.file.get(versionKey) !== version) return;

        const decl = path.get("declaration");

        if (decl.isClassDeclaration() && hasDecorators(decl.node)) {
          if (decl.node.id) {
            // export default class Foo {}
            //   -->
            // class Foo {} export { Foo as default }
            splitExportDeclaration(path);
          } else {
            // Annyms class declarations can be
            // transformed as if they were expressions
            // @ts-expect-error
            decl.node.type = "ClassExpression";
          }
        }
      },
    },
  };
}
