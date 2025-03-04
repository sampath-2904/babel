import { declare } from "@babel/helper-plugin-utils";
import { types as t } from "@babel/core";

export default declare(api => {
  api.assertVersion(7);

  function isProtoKey(node) {
    return t.isLiteral(t.toComputedKey(node, node.key), { value: "__proto__" });
  }

  function isProtoAssignmentExpression(node): node is t.MemberExpression {
    const left = node;
    return (
      t.isMemberExpression(left) &&
      // @ts-expect-error todo(flow->ts): property can be t.PrivateName
      t.isLiteral(t.toComputedKey(left, left.property), { value: "__proto__" })
    );
  }

  function buildDefaultsCallExpression(expr, ref, file) {
    return t.expressionStatement(
      t.callExpression(file.addHelper("defaults"), [ref, expr.right]),
    );
  }

  return {
    name: "transform-proto-to-assign",

    visitor: {
      AssignmentExpression(path, file) {
        if (!isProtoAssignmentExpression(path.node.left)) return;

        const nodes = [];
        const left = path.node.left.object;
        const temp = path.scope.maybeGenerateMemoised(left);

        if (temp) {
          nodes.push(
            t.expressionStatement(t.assignmentExpression("=", temp, left)),
          );
        }
        nodes.push(
          buildDefaultsCallExpression(
            path.node,
            t.cloneNode(temp || left),
            file,
          ),
        );
        if (temp) nodes.push(t.cloneNode(temp));

        path.replaceWithMultiple(nodes);
      },

      ExpressionStatement(path, file) {
        const expr = path.node.expression;
        if (!t.isAssignmentExpression(expr, { operator: "=" })) return;

        if (isProtoAssignmentExpression(expr.left)) {
          path.replaceWith(
            buildDefaultsCallExpression(expr, expr.left.object, file),
          );
        }
      },

      ObjectExpression(path, file) {
        let proto;
        const { node } = path;
        const { properties } = node;

        for (let i = 0; i < properties.length; i++) {
          const prop = properties[i];
          if (isProtoKey(prop)) {
            // @ts-expect-error Fixme: we should also handle ObjectMethod with __proto__ key
            proto = prop.value;
            properties.splice(i, 1);
            break;
          }
        }

        if (proto) {
          const args = [t.objectExpression([]), proto];
          if (node.properties.length) args.push(node);
          path.replaceWith(t.callExpression(file.addHelper("extends"), args));
        }
      },
    },
  };
});
