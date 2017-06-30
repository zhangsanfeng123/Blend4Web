/**
 * Copyright (C) 2014-2017 Triumph LLC
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
"use strict";

/**
 * Node material internal routines.
 * @name nodemat
 * @namespace
 * @exports exports as nodemat
 */
b4w.module["__nodemat"] = function(exports, require) {

var m_cfg     = require("__config");
var m_debug   = require("__debug");
var m_graph   = require("__graph");
var m_mat3    = require("__mat3");
var m_mat4    = require("__mat4");
var m_obj     = require("__objects")
var m_print   = require("__print");
var m_shaders = require("__shaders");
var m_scenes  = require("__scenes");
var m_util    = require("__util");
var m_vec3    = require("__vec3");
var m_tex     = require("__textures");

var _shader_ident_counters = {};
var _composed_ngraph_proxies = {};
var _composed_stack_graphs = {};
var _lamp_indexes = {};
var _lamp_index = 0;

var cfg_def = m_cfg.defaults;

var DEBUG_NODE_GRAPHS = false;

var VECTOR_VALUE = 0;
var SCALAR_VALUE = 1;

var CURVE_POINT_EPS = 0.01;

// NOTE: keep constants synchronized with:
//          shaders/include/std.glsl
//          src/batch.js : update_batch_material_nodes
var VT_POINT  = 0;
var VT_VECTOR = 1;
var VT_NORMAL = 2;

var VT_WORLD_TO_WORLD   = 0;
var VT_WORLD_TO_OBJECT  = 1;
var VT_WORLD_TO_CAMERA  = 2;
var VT_OBJECT_TO_WORLD  = 3;
var VT_OBJECT_TO_OBJECT = 4;
var VT_OBJECT_TO_CAMERA = 5;
var VT_CAMERA_TO_WORLD  = 6;
var VT_CAMERA_TO_OBJECT = 7;
var VT_CAMERA_TO_CAMERA = 8;
exports.VT_WORLD_TO_WORLD   = VT_WORLD_TO_WORLD;
exports.VT_WORLD_TO_OBJECT  = VT_WORLD_TO_OBJECT;
exports.VT_WORLD_TO_CAMERA  = VT_WORLD_TO_CAMERA;
exports.VT_OBJECT_TO_WORLD  = VT_OBJECT_TO_WORLD;
exports.VT_OBJECT_TO_OBJECT = VT_OBJECT_TO_OBJECT;
exports.VT_OBJECT_TO_CAMERA = VT_OBJECT_TO_CAMERA;
exports.VT_CAMERA_TO_WORLD  = VT_CAMERA_TO_WORLD;
exports.VT_CAMERA_TO_OBJECT = VT_CAMERA_TO_OBJECT;
exports.VT_CAMERA_TO_CAMERA = VT_CAMERA_TO_CAMERA;

var NM_TANGENT        = 0;
var NM_OBJECT         = 1;
var NM_WORLD          = 2;
var NM_BLENDER_OBJECT = 3;
var NM_BLENDER_WORLD  = 4;
exports.NM_TANGENT        = NM_TANGENT;
exports.NM_OBJECT         = NM_OBJECT;
exports.NM_WORLD          = NM_WORLD;
exports.NM_BLENDER_OBJECT = NM_BLENDER_OBJECT;
exports.NM_BLENDER_WORLD  = NM_BLENDER_WORLD;

// output_material node input sockets
var OMI_SURFACE      = 0;
// var OMI_VOLUME       = 1;
var OMI_DISPLACEMENT = 2;

exports.get_ngraph_proxy_cached = function(ngraph_id) {
    return _composed_ngraph_proxies[ngraph_id];
}

exports.cleanup_ngraph_proxy = function(ngraph_id) {
    delete _composed_ngraph_proxies[ngraph_id];   
}

exports.compose_ngraph_proxy = compose_ngraph_proxy;
function compose_ngraph_proxy(node_tree, source_id, is_node_group, mat_name,
                            shader_type) {
    var scene_uuid = "";
    if (m_scenes.check_active()) {
        var active_scene = m_scenes.get_active();
        scene_uuid = active_scene["uuid"];
    }
    var ntree_graph_id = generate_graph_id(source_id, shader_type, scene_uuid);

    if (ntree_graph_id in _composed_ngraph_proxies)
        return _composed_ngraph_proxies[ntree_graph_id];

    var ngraph_proxy = {
        graph: null,
        id: ntree_graph_id,
        cleanup_on_unload: true
    }

    if (!is_node_group) {
        // reset lamps counter
        _lamp_indexes = {};
        _lamp_index = 0;
    }

    if (shader_type != "SHADOW" && shader_type != "COLOR_ID") {
        var graph = m_graph.create();

        var bpy_nodes = node_tree["nodes"];

        for (var i = 0; i < bpy_nodes.length; i++) {
            var bpy_node = bpy_nodes[i];
            if (append_nmat_node(graph, bpy_node, 0, mat_name,
                                 shader_type) == null) {
                _composed_ngraph_proxies[ntree_graph_id] = null;
                return ngraph_proxy;
            }
        }

        if (is_node_group)
            if (find_node_id(node_tree, graph, "GROUP_OUTPUT", "group") == -1)
                return ngraph_proxy;

        var node_groups = trace_group_nodes(graph);
        // NOTE: don't change source node_tree (node_group_tree is already copied)
        var links = is_node_group ? node_tree["links"] : node_tree["links"].slice();
        if (!append_node_groups_graphs(graph, links, node_groups))
            return ngraph_proxy;

        if (is_node_group) {
            ngraph_proxy.graph = graph;
            return ngraph_proxy;
        }

        for (var i = 0; i < links.length; i++) {
            var link = links[i];

            // multiple node IDs for single bpy_node will in case of node splitting
            // e.g GEOMETRY node splitting
            var node_ids1 = nmat_node_ids(link["from_node"], graph);
            var node_ids2 = nmat_node_ids(link["to_node"], graph);

            for (var j = 0; j < node_ids1.length; j++) {
                for (var k = 0; k < node_ids2.length; k++) {
                    var node_id1 = node_ids1[j];
                    var node_id2 = node_ids2[k];

                    var node_attr1 = m_graph.get_node_attr(graph, node_id1);
                    var node_attr2 = m_graph.get_node_attr(graph, node_id2);

                    if (!append_nmat_edge(graph, node_id1, node_id2,
                            node_attr1, node_attr2, link)) {
                        _composed_ngraph_proxies[ntree_graph_id] = null;
                        return ngraph_proxy;
                    }
                }
            }
        }

        complete_edges(graph);

        var is_world_mat = false;
        var output_id = -1;
        if (shader_type == "GLOW") {
            output_id = find_node_id(node_tree, graph, "B4W_GLOW_OUTPUT",
                                         "material", true);
        } else {
            output_id = find_node_id(node_tree, graph, "OUTPUT",
                                         "material", false, true);
            if (output_id == -1) {
                output_id = find_node_id(node_tree, graph, "OUTPUT_MATERIAL",
                                         "material", false, true);
            }

            if (output_id == -1) {
                output_id = find_node_id(node_tree, graph, "OUTPUT_WORLD",
                                         "material", false, true);
                is_world_mat = true;
            }

        }
        if (output_id == -1) {
            graph = create_default_nmat_graph();
            output_id = 0;
        }

        nmat_cleanup_graph(graph);
        var graph_out = m_graph.subgraph_node_conn(graph, output_id,
                                                   m_graph.BACKWARD_DIR);

        if (!is_world_mat) {
            split_material_nodes(graph_out, mat_name, shader_type);
            split_cycles_output_nodes(graph_out, mat_name, shader_type);
        } else {
            split_world_output_nodes(graph_out, mat_name, shader_type);
            replace_world_shader_nodes_with_rgbs(graph_out, mat_name, shader_type);
            remove_unsupported_world_nodes(graph_out);
            remove_inconsistent_world_links(graph_out);
        }

        clean_sockets_linked_property(graph_out);

        merge_nodes(graph_out);

        optimize_geometry(graph_out);

        fix_socket_types(graph_out, mat_name, shader_type);
        create_node_textures(graph_out);

    } else {
        var main_ngraph_proxy = compose_ngraph_proxy(node_tree, source_id, is_node_group,
                mat_name, "MAIN");

        var nodes_cb = function(node) {
            var new_node = m_util.clone_object_nr(node);
            new_node.inputs = m_util.clone_object_r(node.inputs);
            new_node.outputs = m_util.clone_object_r(node.outputs);
            return new_node;
        }

        var ntree_graph = m_graph.clone(main_ngraph_proxy.graph, nodes_cb);
        var output_id = find_node_id(node_tree, ntree_graph, "OUTPUT",
                                     "material", false, true);
        if (output_id == -1)
                output_id = find_node_id(node_tree, ntree_graph, "OUTPUT_MATERIAL",
                                         "material", false, true);
        remove_color_output(ntree_graph, output_id);

        var graph_out = m_graph.subgraph_node_conn(ntree_graph, output_id,
                                                   m_graph.BACKWARD_DIR);
        clean_sockets_linked_property(graph_out);
    }


    ngraph_proxy.graph = graph_out;
    _composed_ngraph_proxies[ntree_graph_id] = ngraph_proxy;

    if (DEBUG_NODE_GRAPHS)
        print_node_graph(ngraph_proxy.graph, mat_name);
    return ngraph_proxy;
}

exports.create_lighting_graph = function(source_id, mat_name, data) {
    var active_scene = m_scenes.get_active();
    var ntree_graph_id = generate_graph_id(source_id, "MAIN", active_scene["uuid"]);

    if (ntree_graph_id in _composed_stack_graphs)
        return _composed_stack_graphs[ntree_graph_id];

    var graph = m_graph.create();

    var bpy_node = {"name": "LIGHTING_BEGIN",
                    "type": "LIGHTING_BEGIN"};
    var begin_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);

    bpy_node = {"name": "LIGHTING_END",
                "type": "LIGHTING_END"};
    var end_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);
    var translucency_edges = [[begin_node_id, [8, 10]],
                             [begin_node_id, [9, 6]]];
    add_lighting_subgraph(graph, data, begin_node_id, end_node_id, 
            translucency_edges, mat_name);
    clean_sockets_linked_property(graph);
    _composed_stack_graphs[ntree_graph_id] = graph;
    return graph;
}

function split_material_nodes(graph, mat_name, shader_type) {
    var material_nodes = [];
    m_graph.traverse(graph, function(id, node) {
        if (node.type == "MATERIAL" || node.type == "MATERIAL_EXT") {
            var material = {
                node_id: id,
                node: node
            }
            material_nodes.push(material);
        }
    });

    for (var i = 0; i < material_nodes.length; ++i) {
        var node_id = material_nodes[i].node_id;
        var node = material_nodes[i].node;

        var material_begin_id = m_graph.gen_node_id(graph);
        m_graph.append_node(graph, material_begin_id, node.data.material_begin);
        var material_end_id = m_graph.gen_node_id(graph);
        m_graph.append_node(graph, material_end_id, node.data.material_end);

        // normal
        m_graph.append_edge(graph, material_begin_id, material_end_id, [4,2]);

        var material_socket_map = {
            5: ["LIGHTING_APPLY", 10], // translucency_color
            6: ["LIGHTING_APPLY", 6], // translucency_params
            7: ["MATERIAL_END", 3], // reflect_factor
            8: ["MATERIAL_END", 4], // specular_alpha
            9: ["MATERIAL_END", 5], // alpha_in
        }

        var in_count = m_graph.in_edge_count(graph, node_id);
        var remove_edges_in = [];
        var append_edges_in = [];
        var translucency_edges = [];

        // process every edges ingoing to material/material_ext node
        var edges_in_counter = {}
        for (var k = 0; k < in_count; k++) {
            var in_id = m_graph.get_in_edge(graph, node_id, k);

            if (!(in_id in edges_in_counter))
                edges_in_counter[in_id] = 0;
            var edge_attr = m_graph.get_edge_attr(graph, in_id,
                    node_id, edges_in_counter[in_id]++);

            // removing/appending edges affects graph traversal
            remove_edges_in.push([in_id, node_id, edge_attr]);

            var dest = material_socket_map[edge_attr[1]]
            if (dest)
                switch (dest[0]) {
                case "MATERIAL_END":
                    append_edges_in.push([in_id, material_end_id, [edge_attr[0], dest[1]]]);
                    break;
                case "LIGHTING_APPLY":
                    translucency_edges.push([in_id, [edge_attr[0], dest[1]]]);
                    break;
                }
            else
                append_edges_in.push([in_id, material_begin_id, edge_attr]);
        }

        add_lighting_subgraph(graph, node.data.value, 
                material_begin_id, material_end_id, translucency_edges, 
                mat_name);

        for (var k = 0; k < remove_edges_in.length; k++) 
            m_graph.remove_edge_by_attr(graph, remove_edges_in[k][0],
                    remove_edges_in[k][1], remove_edges_in[k][2]);
        for (var k = 0; k < append_edges_in.length; k++)
            m_graph.append_edge(graph, append_edges_in[k][0],
                    append_edges_in[k][1], append_edges_in[k][2]);

        var out_count = m_graph.out_edge_count(graph, node_id);
        var remove_out_edges = [];
        var append_out_edges = [];
        // process every outgoing edge
        var edges_out_counter = {}
        for (var k = 0; k < out_count; k++) {
            var out_id = m_graph.get_out_edge(graph, node_id, k);

            if (!(out_id in edges_out_counter))
                edges_out_counter[out_id] = 0;
            var edge_attr = m_graph.get_edge_attr(graph, node_id,
                    out_id, edges_out_counter[out_id]++);

            // removing/appending edges affects graph traversal
            remove_out_edges.push([node_id, out_id, edge_attr]);
            append_out_edges.push([material_end_id, out_id, edge_attr]);
        }

        for (var k = 0; k < remove_out_edges.length; k++)
            m_graph.remove_edge_by_attr(graph, remove_out_edges[k][0],
                    remove_out_edges[k][1], remove_out_edges[k][2]);

        for (var k = 0; k < append_out_edges.length; k++)
            m_graph.append_edge(graph, append_out_edges[k][0],
                    append_out_edges[k][1], append_out_edges[k][2]);

        m_graph.remove_node(graph, node_id);
    }
}

function add_lighting_subgraph(graph, data, begin_node_id, end_node_id,
        translucency_edges, mat_name) {
    var bpy_node = {"name": "LIGHTING_AMBIENT",
                    "type": "LIGHTING_AMBIENT"};
    var curr_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);
    var prev_node_id = curr_node_id;

    link_edge_by_ident(graph, begin_node_id, curr_node_id, "E");
    link_edge_by_ident(graph, begin_node_id, curr_node_id, "A");
    link_edge_by_ident(graph, begin_node_id, curr_node_id, "D");

    var scene = m_scenes.get_active();
    var lamps = m_obj.get_scene_objs(scene, "LAMP", m_obj.DATA_ID_ALL);

    if (!data.use_shadeless) {
        var lamp_node_id;
        var lighting_apply_node_id;
        var shade_spec_node_id;
        var shade_dif_node_id;

        for (var i = 0; i < lamps.length; i++) {
            var light = lamps[i].light;

            bpy_node = {"name": "LIGHTING_LAMP",
                        "type": "LIGHTING_LAMP"};
            lamp_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);
            bpy_node = {"name": "LIGHTING_APPLY",
                        "type": "LIGHTING_APPLY"};
            lighting_apply_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);

            // LIGHTING_APPLY inputs
            link_edge_by_ident(graph, prev_node_id, lighting_apply_node_id, "color");
            link_edge_by_ident(graph, prev_node_id, lighting_apply_node_id, "specular");
            link_edge_by_ident(graph, lamp_node_id, lighting_apply_node_id, "ldir");
            link_edge_by_ident(graph, begin_node_id, lighting_apply_node_id, "normal");
            link_edge_by_ident(graph, begin_node_id, lighting_apply_node_id, "D");
            link_edge_by_ident(graph, begin_node_id, lighting_apply_node_id, "S");
            link_edge_by_ident(graph, lamp_node_id, lighting_apply_node_id, "lcolorint");

            // LIGHTING_LAMP input
            link_edge_by_ident(graph, begin_node_id, lamp_node_id, "shadow_factor");

            var spec_name = "SPECULAR_" + data.specular_shader;
            bpy_node = {"name": spec_name,
                        "type": spec_name,
                        "use_tangent_shading" : data.use_tangent_shading};
            shade_spec_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);

            // SPECULAR inputs
            link_edge_by_ident(graph, lamp_node_id, shade_spec_node_id, "ldir");
            link_edge_by_ident(graph, lamp_node_id, shade_spec_node_id, "lfac");
            link_edge_by_ident(graph, begin_node_id, shade_spec_node_id, "normal");

            // SPECULAR output
            link_edge_by_ident(graph, shade_spec_node_id, lighting_apply_node_id, "sfactor");

            link_edge_by_ident(graph, lamp_node_id, shade_spec_node_id, "norm_fac");
            link_edge_by_ident(graph, begin_node_id, shade_spec_node_id, "sp_params");

            if (light.type == "HEMI")
                var dif_name = "DIFFUSE_LAMBERT";
            else
                var dif_name = "DIFFUSE_" + data.diffuse_shader;

            bpy_node = {"name": dif_name, 
                        "type": dif_name,
                        "use_tangent_shading" : data.use_tangent_shading};
            shade_dif_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);

            // DIFFUSE inputs
            link_edge_by_ident(graph, lamp_node_id, shade_dif_node_id, "ldir");
            link_edge_by_ident(graph, lamp_node_id, shade_dif_node_id, "lfac");
            link_edge_by_ident(graph, begin_node_id, shade_dif_node_id, "normal");
            link_edge_by_ident(graph, lamp_node_id, shade_dif_node_id, "norm_fac");

            // DIFFUSE output
            link_edge_by_ident(graph, shade_dif_node_id, lighting_apply_node_id, "lfactor");
            
            if (dif_name != "DIFFUSE_LAMBERT")
                link_edge_by_ident(graph, begin_node_id, shade_dif_node_id, "dif_params");

            for (var j = 0; j < translucency_edges.length; j++) {
                var in_node_id = translucency_edges[j][0];
                var edge_attr = translucency_edges[j][1];
                m_graph.append_edge(graph, in_node_id, lighting_apply_node_id, edge_attr);
            }

            prev_node_id = lighting_apply_node_id;
        }
    }
    link_edge_by_ident(graph, prev_node_id, end_node_id, "color");
    link_edge_by_ident(graph, prev_node_id, end_node_id, "specular");
}

function link_edge_by_ident(graph, id1, id2, inout_ident) {
    var node1 = m_graph.get_node_attr(graph, id1);
    var node2 = m_graph.get_node_attr(graph, id2);

    var in2 = -1;
    var n2_inputs = node2.inputs;
    for (var i = 0; i < n2_inputs.length; i++) {
        var input = n2_inputs[i];
        if (inout_ident == input.identifier) {
            in2 = i;
            break;
        }
    }

    if (in2 == -1)
        return;

    var out1 = -1;
    var n1_outputs = node1.outputs;
    for (var i = 0; i < n1_outputs.length; i++) {
        var output = n1_outputs[i];
        if (inout_ident == output.identifier) {
            out1 = i;
            break;
        }
    }

    if (out1 == -1)
        return;

    m_graph.append_edge(graph, id1, id2, [out1, in2]);
    n1_outputs[out1].is_linked = true;
    n2_inputs[in2].is_linked = true;
}

function split_cycles_output_nodes(graph, mat_name, shader_type) {
    var output_material_nodes = [];
    m_graph.traverse(graph, function(id, node) {
        if (node.type == "OUTPUT_MATERIAL") {
            var out_mat = {
                node_id: id,
                node: node
            }
            output_material_nodes.push(out_mat);
        }
    });

    for (var i = 0; i < output_material_nodes.length; ++i) {
        var om_id = output_material_nodes[i].node_id;
        var om_node = output_material_nodes[i].node;
        var use_surface = false;
        var use_displacement = false;

        var srf_output_id = m_graph.gen_node_id(graph);
        m_graph.append_node(graph, srf_output_id, om_node.data.output_surface);

        var in_count = m_graph.in_edge_count(graph, om_id);
        var remove_edges_in = [];
        var append_edges_in = [];

        // process every edges ingoing to output_material nodes
        var edges_in_counter = {}
        for (var j = 0; j < in_count; j++) {
            var in_id = m_graph.get_in_edge(graph, om_id, j);

            if (!(in_id in edges_in_counter))
                edges_in_counter[in_id] = 0;
            var edge_attr = m_graph.get_edge_attr(graph, in_id,
                    om_id, edges_in_counter[in_id]++);

            // removing/appending edges affects graph traversal
            remove_edges_in.push([in_id, om_id, edge_attr]);

            switch (edge_attr[1]) {
            case OMI_SURFACE:
                use_surface = true;
                append_edges_in.push([in_id, srf_output_id, edge_attr]);
                break;
            case OMI_DISPLACEMENT:
                use_displacement = true;
                var dsp_bump_id = m_graph.gen_node_id(graph);
                m_graph.append_node(graph, dsp_bump_id, om_node.data.displacement_bump);
                // height input of dsp bump
                append_edges_in.push([in_id, dsp_bump_id, [edge_attr[0], 0]]);
                break;
            }
        }

        for (var j = 0; j < remove_edges_in.length; j++)
            m_graph.remove_edge_by_attr(graph, remove_edges_in[j][0],
                    remove_edges_in[j][1], remove_edges_in[j][2]);
        for (var j = 0; j < append_edges_in.length; j++)
            m_graph.append_edge(graph, append_edges_in[j][0],
                    append_edges_in[j][1], append_edges_in[j][2]);

        m_graph.remove_node(graph, om_id);

        if (use_surface) {
            if (use_displacement)
                separate_displacement_bump_subgraph(graph, srf_output_id, dsp_bump_id);

            split_surface_output_nodes(graph, mat_name, shader_type);

        } else {
            var dummy_output = m_graph.get_node_attr(graph, srf_output_id);

            graph.nodes = [0, dummy_output];
            graph.edges = [];
        }
    }
}

function separate_displacement_bump_subgraph(graph, srf_output_id, dsp_bump_id) {
    var srf_graph = m_graph.subgraph_node_conn(graph, srf_output_id,
                                                   m_graph.BACKWARD_DIR);
    var dn_id_arr = get_def_normal_nodes_ids(srf_graph);

    if (dn_id_arr.length) {
        var dsp_bump_subgraph = m_graph.subgraph_node_conn(graph, dsp_bump_id,
                                                       m_graph.BACKWARD_DIR);
        var dsp_bump_subgraph_clone = clone_nmat_graph(dsp_bump_subgraph);

        m_graph.traverse(dsp_bump_subgraph_clone, function(id, node) {
            var new_name = "displacement%join%" + node.name;
            node.name = new_name;
        });

        m_graph.append_subgraph(dsp_bump_subgraph_clone, srf_graph, [], []);

        var new_dsp_bump_id = -1;
        m_graph.traverse(srf_graph, function(id, node) {
            if (node.type == "DISPLACEMENT_BUMP") {
                new_dsp_bump_id = id;
                return 1;
            }
        });

        for (var i = 0; i < dn_id_arr.length; i++) {
            var dn_id = dn_id_arr[i];
            var dn_node = m_graph.get_node_attr(srf_graph, dn_id);

            link_edge_by_ident(srf_graph, new_dsp_bump_id, dn_id, "Normal");
            override_node_dir_value(dn_node, "USE_NORMAL_IN", 1);
        }
    }

    graph.nodes = srf_graph.nodes;
    graph.edges = srf_graph.edges;
}

function override_node_dir_value(node, dir_name, dir_value) {
    var dirs = node.dirs;
    for (var i = 0; i < dirs.length; i++) {
        var dir = dirs[i];
        if (dir[0] == dir_name)
            dir[1] = dir_value;
    }
}

function get_def_normal_nodes_ids(graph) {
    //all nodes which will use default/geometry normal
    var def_normal_nodes = [];
    m_graph.traverse(graph, function(id, node) {
        var has_unused_normal_input = false;
        var inputs = node.inputs;
        for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].identifier == "Normal") {
                has_unused_normal_input = !inputs[i].is_linked;
                break;
            }
        }

        if (has_unused_normal_input) {
            def_normal_nodes.push(id);
        }

    });

    return def_normal_nodes;
}

function split_surface_output_nodes(graph, mat_name, shader_type) {
    var output_surface_nodes = [];
    m_graph.traverse(graph, function(id, node) {
        if (node.type == "OUTPUT_SURFACE") {
            var out_mat = {
                node_id: id,
                node: node
            }
            output_surface_nodes.push(out_mat);
        }
    });

    var mix_shader_nodes = [];
    if (output_surface_nodes.length)
        m_graph.traverse(graph, function(id, node) {
            if (node.type == "MIX_SHADER") {
                var mix_sh = {
                    node_id: id,
                    node: node
                }
                mix_shader_nodes.push(mix_sh);
            }
        });

    for (var i = 0; i < output_surface_nodes.length; ++i) {
        var node_id = output_surface_nodes[i].node_id;
        var node = output_surface_nodes[i].node;

        var bsdf_begin_id = m_graph.gen_node_id(graph);
        m_graph.append_node(graph, bsdf_begin_id, node.data.bsdf_begin);
        var bsdf_end_id = m_graph.gen_node_id(graph);
        m_graph.append_node(graph, bsdf_end_id, node.data.bsdf_end);

        // normal
        m_graph.append_edge(graph, bsdf_begin_id, bsdf_end_id, [4,2]);

        // var bsdf_socket_map = {
        //     // 5: ["LIGHTING_APPLY", 10], // translucency_color
        //     // 6: ["LIGHTING_APPLY", 6], // translucency_params
        //     // 7: ["BSDF_END", 3], // reflect_factor
        //     // 8: ["BSDF_END", 4], // specular_alpha
        //     // 9: ["BSDF_END", 5], // alpha_in
        // }

        var in_count = m_graph.in_edge_count(graph, node_id);
        var remove_edges_in = [];
        var append_edges_in = [];
        var translucency_edges = [];

        // process every edges ingoing to output_surface nodes
        var edges_in_counter = {}
        for (var k = 0; k < in_count; k++) {
            var in_id = m_graph.get_in_edge(graph, node_id, k);
            var in_node = m_graph.get_node_attr(graph, in_id);

            if (!(in_id in edges_in_counter))
                edges_in_counter[in_id] = 0;
            var edge_attr = m_graph.get_edge_attr(graph, in_id,
                    node_id, edges_in_counter[in_id]++);

            // removing/appending edges affects graph traversal
            remove_edges_in.push([in_id, node_id, edge_attr]);

            // var dest = bsdf_socket_map[edge_attr[1]]
            // if (dest)
            //     switch (dest[0]) {
            //     case "BSDF_END":
            //         append_edges_in.push([in_id, bsdf_end_id, [edge_attr[0], dest[1]]]);
            //         break;
            //     case "LIGHTING_APPLY":
            //         translucency_edges.push([in_id, [edge_attr[0], dest[1]]]);
            //         break;
            //     }
            // else
            append_edges_in.push([in_id, bsdf_begin_id, edge_attr]);

            if (in_node.type == "BSDF_GLOSSY" || in_node.type == "BSDF_DIFFUSE" || in_node.type == "MIX_SHADER" ||
                    in_node.type == "EMISSION" || in_node.type == "BSDF_TRANSPARENT") {
                // d_color
                append_edges_in.push([in_id, bsdf_begin_id, [1, 1]]);
                // d_roughness
                append_edges_in.push([in_id, bsdf_begin_id, [2, 2]]);
                // s_color
                append_edges_in.push([in_id, bsdf_begin_id, [3, 3]]);
                // s_roughness
                append_edges_in.push([in_id, bsdf_begin_id, [4, 4]]);
                // metalness
                append_edges_in.push([in_id, bsdf_begin_id, [5, 5]]);
                // normal
                append_edges_in.push([in_id, bsdf_begin_id, [6, 6]]);
                // e_color
                append_edges_in.push([in_id, bsdf_begin_id, [7, 7]]);
                // emission
                append_edges_in.push([in_id, bsdf_begin_id, [8, 8]]);
                // a_color
                append_edges_in.push([in_id, bsdf_begin_id, [9, 9]]);
                // alpha
                append_edges_in.push([in_id, bsdf_begin_id, [10, 10]]);

                // additional links between all bsdf and shader mixing nodes
                for (var j = 0; j < mix_shader_nodes.length; ++j) {
                    var mix_node_id = mix_shader_nodes[j].node_id;
                    var mix_in_count = m_graph.in_edge_count(graph, mix_node_id);

                    for (var m = 0; m < mix_in_count; m++) {
                        var mix_in_id = m_graph.get_in_edge(graph, mix_node_id, m);
                        var mix_in_node = m_graph.get_node_attr(graph, mix_in_id);
                        var mix_in_edge_attr = m_graph.get_edge_attr(graph, mix_in_id, mix_node_id, 0);
                        // not Factor input
                        if (mix_in_edge_attr[1] != 0) {
                            if (mix_in_node.type == "BSDF_GLOSSY" || mix_in_node.type == "BSDF_DIFFUSE" || mix_in_node.type == "MIX_SHADER" ||
                                    mix_in_node.type == "EMISSION" || mix_in_node.type == "BSDF_TRANSPARENT") {

                                // inputs 0-2 standard (Factor, Shader, Shader)
                                var edge_attr_offset = mix_in_edge_attr[1] == 1 ? 3 : 13;

                                // d_color
                                append_edges_in.push([mix_in_id, mix_node_id, [1, edge_attr_offset]]);
                                // d_roughness
                                append_edges_in.push([mix_in_id, mix_node_id, [2, edge_attr_offset+1]]);
                                // s_color
                                append_edges_in.push([mix_in_id, mix_node_id, [3, edge_attr_offset+2]]);
                                // s_roughness
                                append_edges_in.push([mix_in_id, mix_node_id, [4, edge_attr_offset+3]]);
                                // metalness
                                append_edges_in.push([mix_in_id, mix_node_id, [5, edge_attr_offset+4]]);
                                // normal
                                append_edges_in.push([mix_in_id, mix_node_id, [6, edge_attr_offset+5]]);
                                // e_color
                                append_edges_in.push([mix_in_id, mix_node_id, [7, edge_attr_offset+6]]);
                                // emission
                                append_edges_in.push([mix_in_id, mix_node_id, [8, edge_attr_offset+7]]);
                                // a_color
                                append_edges_in.push([mix_in_id, mix_node_id, [9, edge_attr_offset+8]]);
                                // alpha
                                append_edges_in.push([mix_in_id, mix_node_id, [10, edge_attr_offset+9]]);
                            }
                        }
                    }
                }
            }
        }

        add_bsdf_subgraph(graph, node.data.value, bsdf_begin_id, bsdf_end_id, translucency_edges, mat_name);

        append_edges_in.push([bsdf_end_id, node_id, [0,0]]);

        for (var k = 0; k < remove_edges_in.length; k++)
            m_graph.remove_edge_by_attr(graph, remove_edges_in[k][0],
                    remove_edges_in[k][1], remove_edges_in[k][2]);
        for (var k = 0; k < append_edges_in.length; k++)
            m_graph.append_edge(graph, append_edges_in[k][0],
                    append_edges_in[k][1], append_edges_in[k][2]);
    }
}

function add_bsdf_subgraph(graph, data, begin_node_id, end_node_id, translucency_edges, mat_name) {
    var bpy_node = {"name": "LIGHTING_AMBIENT",
                    "type": "LIGHTING_AMBIENT"};
    var curr_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);
    var prev_node_id = curr_node_id;

    link_edge_by_ident(graph, begin_node_id, curr_node_id, "E");
    link_edge_by_ident(graph, begin_node_id, curr_node_id, "A");
    link_edge_by_ident(graph, begin_node_id, curr_node_id, "D");

    var scene = m_scenes.get_active();
    var lamps = m_obj.get_scene_objs(scene, "LAMP", m_obj.DATA_ID_ALL);

    var lamp_node_id;
    var lighting_apply_node_id;
    var shade_dif_node_id;

    for (var i = 0; i < lamps.length; i++) {
        bpy_node = {"name": "LIGHTING_LAMP",
                    "type": "LIGHTING_LAMP"};
        lamp_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);
        bpy_node = {"name": "LIGHTING_APPLY",
                    "type": "LIGHTING_APPLY"};
        lighting_apply_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);

        // LIGHTING_APPLY inputs
        link_edge_by_ident(graph, prev_node_id, lighting_apply_node_id, "color");
        link_edge_by_ident(graph, prev_node_id, lighting_apply_node_id, "specular");
        link_edge_by_ident(graph, lamp_node_id, lighting_apply_node_id, "ldir");
        link_edge_by_ident(graph, begin_node_id, lighting_apply_node_id, "normal");
        link_edge_by_ident(graph, begin_node_id, lighting_apply_node_id, "D");
        link_edge_by_ident(graph, begin_node_id, lighting_apply_node_id, "S");
        link_edge_by_ident(graph, lamp_node_id, lighting_apply_node_id, "lcolorint");

        // LIGHTING_LAMP input
        link_edge_by_ident(graph, begin_node_id, lamp_node_id, "shadow_factor");

        var bsdf_name = data.bsdf_shader;

        bpy_node = {"name": bsdf_name,
                    "type": bsdf_name};
        shade_dif_node_id = append_nmat_node(graph, bpy_node, 0, mat_name, null);

        // BSDF inputs
        link_edge_by_ident(graph, lamp_node_id, shade_dif_node_id, "ldir");
        link_edge_by_ident(graph, lamp_node_id, shade_dif_node_id, "lfac");
        link_edge_by_ident(graph, begin_node_id, shade_dif_node_id, "normal");
        link_edge_by_ident(graph, lamp_node_id, shade_dif_node_id, "norm_fac");
        link_edge_by_ident(graph, begin_node_id, shade_dif_node_id, "bsdf_params");

        // BSDF output
        link_edge_by_ident(graph, shade_dif_node_id, lighting_apply_node_id, "lfactor");
        link_edge_by_ident(graph, shade_dif_node_id, lighting_apply_node_id, "sfactor");

        for (var j = 0; j < translucency_edges.length; j++) {
            var in_node_id = translucency_edges[j][0];
            var edge_attr = translucency_edges[j][1];
            m_graph.append_edge(graph, in_node_id, lighting_apply_node_id, edge_attr);
        }

        prev_node_id = lighting_apply_node_id;
    }

    link_edge_by_ident(graph, begin_node_id, end_node_id, "bsdf_params");
    link_edge_by_ident(graph, begin_node_id, end_node_id, "d_color");
    link_edge_by_ident(graph, begin_node_id, end_node_id, "s_color");
    link_edge_by_ident(graph, begin_node_id, end_node_id, "e_color");
    link_edge_by_ident(graph, begin_node_id, end_node_id, "emission");
    link_edge_by_ident(graph, begin_node_id, end_node_id, "a_color");
    link_edge_by_ident(graph, begin_node_id, end_node_id, "alpha");

    link_edge_by_ident(graph, prev_node_id, end_node_id, "color");
    link_edge_by_ident(graph, prev_node_id, end_node_id, "specular");
}

function split_world_output_nodes(graph, mat_name, shader_type) {
    var output_world_nodes = [];
    m_graph.traverse(graph, function(id, node) {
        if (node.type == "OUTPUT_WORLD") {
            var out_mat = {
                node_id: id,
                node: node
            }
            output_world_nodes.push(out_mat);
        }
    });

    for (var i = 0; i < output_world_nodes.length; ++i) {
        var ow_id = output_world_nodes[i].node_id;
        var ow_node = output_world_nodes[i].node;

        var srf_output_id = m_graph.gen_node_id(graph);
        m_graph.append_node(graph, srf_output_id, ow_node.data.output_world_surface);

        var in_count = m_graph.in_edge_count(graph, ow_id);
        var remove_edges_in = [];
        var append_edges_in = [];

        // process every edges ingoing to output_material nodes
        var edges_in_counter = {};
        for (var j = 0; j < in_count; j++) {
            var in_id = m_graph.get_in_edge(graph, ow_id, j);

            if (!(in_id in edges_in_counter))
                edges_in_counter[in_id] = 0;
            var edge_attr = m_graph.get_edge_attr(graph, in_id,
                    ow_id, edges_in_counter[in_id]++);

            // removing/appending edges affects graph traversal
            remove_edges_in.push([in_id, ow_id, edge_attr]);

            switch (edge_attr[1]) {
            case OMI_SURFACE:
                append_edges_in.push([in_id, srf_output_id, edge_attr]);
                break;
            }
        }

        for (var j = 0; j < remove_edges_in.length; j++)
            m_graph.remove_edge_by_attr(graph, remove_edges_in[j][0],
                    remove_edges_in[j][1], remove_edges_in[j][2]);
        for (var j = 0; j < append_edges_in.length; j++)
            m_graph.append_edge(graph, append_edges_in[j][0],
                    append_edges_in[j][1], append_edges_in[j][2]);

        m_graph.remove_node(graph, ow_id);
    }
}

function replace_world_shader_nodes_with_rgbs(graph, mat_name, shader_type) {
    var remove_nodes = [];
    m_graph.traverse(graph, function(id, node) {
        if (node.type == "MIX_SHADER" || node.type == "ADD_SHADER") {
            var shader_node = {
                node_id: id,
                node: node
            };
            remove_nodes.push(shader_node);
        }
    });

    if (remove_nodes.length) {
        var bpy_node = {"name": "RGB_WORLD_NODE",
                        "type": "RGB_WORLD_NODE",
                        "factor": 0.5};

        for (var i = 0; i < remove_nodes.length; i++) {
            var node_id = remove_nodes[i].node_id;
            var node = remove_nodes[i].node;

            bpy_node["name"] = node.name;
            bpy_node["fac"]= node.inputs[0].default_value;
            bpy_node["fac_is_linked"] = node.inputs[0].is_linked;
            bpy_node["color1_is_linked"] = node.inputs[1].is_linked;
            bpy_node["color2_is_linked"] = node.inputs[2].is_linked;
            switch (node.type) {
            case "ADD_SHADER":
                bpy_node["type"] = "ADD_WORLD_RGB";
                break;
            case "MIX_SHADER":
                bpy_node["type"] = "MIX_WORLD_RGB";
                break;
            }

            var rgb_world_id = append_nmat_node(graph, bpy_node, 0, "", shader_type);


            var in_count = m_graph.in_edge_count(graph, node_id);
            var remove_edges_in = [];
            var append_edges_in = [];
            // process every ingoing edge
            var edges_in_counter = {};
            for (var k = 0; k < in_count; k++) {
                var in_id = m_graph.get_in_edge(graph, node_id, k);

                if (!(in_id in edges_in_counter))
                    edges_in_counter[in_id] = 0;
                var edge_attr = m_graph.get_edge_attr(graph, in_id,
                        node_id, edges_in_counter[in_id]++);

                // removing/appending edges affects graph traversal
                remove_edges_in.push([in_id, node_id, edge_attr]);
                append_edges_in.push([in_id, rgb_world_id, edge_attr]);
            }

            for (var k = 0; k < remove_edges_in.length; k++)
                m_graph.remove_edge_by_attr(graph, remove_edges_in[k][0],
                        remove_edges_in[k][1], remove_edges_in[k][2]);
            for (var k = 0; k < append_edges_in.length; k++)
                m_graph.append_edge(graph, append_edges_in[k][0],
                        append_edges_in[k][1], append_edges_in[k][2]);


            var out_count = m_graph.out_edge_count(graph, node_id);
            var remove_out_edges = [];
            var append_out_edges = [];
            // process every outgoing edge
            var edges_out_counter = {};
            for (var k = 0; k < out_count; k++) {
                var out_id = m_graph.get_out_edge(graph, node_id, k);

                if (!(out_id in edges_out_counter))
                    edges_out_counter[out_id] = 0;
                var edge_attr = m_graph.get_edge_attr(graph, node_id,
                        out_id, edges_out_counter[out_id]++);

                // removing/appending edges affects graph traversal
                remove_out_edges.push([node_id, out_id, edge_attr]);
                append_out_edges.push([rgb_world_id, out_id, edge_attr]);
            }

            for (var k = 0; k < remove_out_edges.length; k++)
                m_graph.remove_edge_by_attr(graph, remove_out_edges[k][0],
                        remove_out_edges[k][1], remove_out_edges[k][2]);

            for (var k = 0; k < append_out_edges.length; k++)
                m_graph.append_edge(graph, append_out_edges[k][0],
                        append_out_edges[k][1], append_out_edges[k][2]);

            m_graph.remove_node(graph, node_id);
        }
    }
}

function remove_unsupported_world_nodes(graph) {
    var output_ws_id = -1;
    var remove_nodes = [];
    var remove_edges = [];

    var supported_world_node_types = [
            "OUTPUT_WORLD_SURFACE", "BACKGROUND", "RGB", "VALUE", "ADD_WORLD_RGB", "MIX_WORLD_RGB", "TEXTURE_ENVIRONMENT_EQUIRECTANGULAR",
            "TEXTURE_ENVIRONMENT_MIRROR_BALL", "GEOMETRY_NO", "GEOMETRY_TRN", "GEOMETRY_GL", "GEOMETRY_IN", "TEXTURE_COLOR",
            "TEX_COORD_GE", "TEX_COORD_OB", "TEX_COORD_NO",
            "COMBRGB", "COMBHSV", "CURVE_RGB", "CURVE_VEC", "B4W_LINEAR_TO_SRGB", "B4W_NORMAL_VIEW", "B4W_VECTOR_VIEW",
            "B4W_SRGB_TO_LINEAR", "B4W_REFLECT", "B4W_CLAMP", "B4W_TIME", "B4W_SMOOTHSTEP", "NORMAL", "MAPPING",
            "MATH_ADD", "MATH_SUBTRACT", "MATH_MULTIPLY", "MATH_DIVIDE", "MATH_SINE", "MATH_COSINE",
            "MATH_TANGENT", "MATH_ARCSINE", "MATH_ARCCOSINE", "MATH_ARCTANGENT", "MATH_POWER", "MATH_LOGARITHM", "MATH_MINIMUM",
            "MATH_MAXIMUM", "MATH_ROUND", "MATH_LESS_THAN", "MATH_GREATER_THAN", "MATH_MODULO","MATH_ABSOLUTE",
            "MIX_RGB_MIX", "MIX_RGB_ADD", "MIX_RGB_MULTIPLY", "MIX_RGB_SUBTRACT", "MIX_RGB_SCREEN", "MIX_RGB_DIVIDE",
            "MIX_RGB_DIFFERENCE", "MIX_RGB_DARKEN", "MIX_RGB_LIGHTEN", "MIX_RGB_OVERLAY", "MIX_RGB_DODGE", "MIX_RGB_BURN",
            "MIX_RGB_HUE", "MIX_RGB_SATURATION", "MIX_RGB_VALUE", "MIX_RGB_COLOR", "MIX_RGB_SOFT_LIGHT", "MIX_RGB_LINEAR_LIGHT",
            "SEPRGB", "SEPHSV", "VALTORGB", "VECT_TRANSFORM", "VECT_MATH_ADD",
            "VECT_MATH_SUBTRACT", "VECT_MATH_AVERAGE", "VECT_MATH_DOT_PRODUCT", "VECT_MATH_CROSS_PRODUCT", "VECT_MATH_NORMALIZE"
    ];

    m_graph.traverse(graph, function(id, node) {
        var node_type = node.type;

        switch (supported_world_node_types.indexOf(node_type)) {
        case -1: // not supported
            var useless_node = {
                node_id: id,
                node: node
            };
            remove_nodes.push(useless_node);
            break;
        case 0: // OUTPUT_WORLD_SURFACE
            output_ws_id = id;
            break;
        }
    });

    for (var i = 0; i < remove_nodes.length; i++) {
        var node_id = remove_nodes[i].node_id;
        // var node = remove_nodes[i].node;

        var out_count = m_graph.out_edge_count(graph, node_id);
        var edges_out_counter = {};
        for (var j = 0; j < out_count; j++) {
            var out_id = m_graph.get_out_edge(graph, node_id, j);
            // var out_node = m_graph.get_node_attr(graph, out_id);

            if (!(out_id in edges_out_counter))
                edges_out_counter[out_id] = 0;
            var edge_attr = m_graph.get_edge_attr(graph, node_id,
                    out_id, edges_out_counter[out_id]++);

            // removing/appending edges affects graph traversal
            remove_edges.push([node_id, out_id, edge_attr]);
        }
    }

    // TODO: replace def values for unlinked inputs with zeros
    for (var i = 0; i < remove_edges.length; i++)
        m_graph.remove_edge_by_attr(graph, remove_edges[i][0],
                remove_edges[i][1], remove_edges[i][2]);

    if (remove_edges.length) {
        var world_graph = m_graph.subgraph_node_conn(graph, output_ws_id,
                                                           m_graph.BACKWARD_DIR);
        graph.nodes = world_graph.nodes;
        graph.edges = world_graph.edges;
    }
}

function remove_inconsistent_world_links(graph) {
    var output_ws_id = -1;
    var suspicious_nodes = [];
    var remove_edges = [];

    m_graph.traverse(graph, function(id, node) {
        var node_type = node.type;

        switch (node_type) {
        case "ADD_WORLD_RGB":
        case "MIX_WORLD_RGB":
            var susp_node = {
                node_id: id,
                node: node
            };
            suspicious_nodes.push(susp_node);
            break;
        case "OUTPUT_WORLD_SURFACE":
            output_ws_id = id;
            var susp_node = {
                node_id: id,
                node: node
            };
            suspicious_nodes.push(susp_node);
            break;
        }
    });

    for (var i = 0; i < suspicious_nodes.length; i++) {
        var node_id = suspicious_nodes[i].node_id;
        var node = suspicious_nodes[i].node;

        var in_count = m_graph.in_edge_count(graph, node_id);
        var edges_in_counter = {};
        for (var j = 0; j < in_count; j++) {
            var in_id = m_graph.get_in_edge(graph, node_id, j);
            var in_node = m_graph.get_node_attr(graph, in_id);

            if (!(in_id in edges_in_counter))
                edges_in_counter[in_id] = 0;
            var edge_attr = m_graph.get_edge_attr(graph, in_id,
                    node_id, edges_in_counter[in_id]++);

            if((node.type == "OUTPUT_WORLD_SURFACE" || edge_attr[1] != 0) &&
                    in_node.type != "ADD_WORLD_RGB" && in_node.type != "MIX_WORLD_RGB" &&
                    in_node.type != "BACKGROUND")
                remove_edges.push([in_id, node_id, edge_attr]); // removing edges affects graph traversal
        }
    }

    // TODO: replace def values for unlinked inputs with zeros
    for (var i = 0; i < remove_edges.length; i++)
        m_graph.remove_edge_by_attr(graph, remove_edges[i][0],
                remove_edges[i][1], remove_edges[i][2]);

    if (remove_edges.length) {
        var world_graph = m_graph.subgraph_node_conn(graph, output_ws_id,
                                                           m_graph.BACKWARD_DIR);
        graph.nodes = world_graph.nodes;
        graph.edges = world_graph.edges;
    }
}

function generate_graph_id(graph_id, shader_type, scene_id) {
    switch (shader_type) {
    case "GLOW":
        // use color output, it is glow
        return graph_id + scene_id + "11";
    case "COLOR_ID":
    case "SHADOW":
        // don't use color output, it isn't glow
        return graph_id + scene_id + "00";
    default:
        // use color output, it isn't glow
        return graph_id + scene_id + "10";
    }
}

function remove_color_output(graph, output_id) {

    m_graph.traverse_edges(graph, function(id1, id2, attr) {
        var out_node = m_graph.get_node_attr(graph, id2);
        if (id2 == output_id && out_node.inputs[attr[1]].identifier == "Color")
            m_graph.remove_edge_by_attr(graph, id1, id2, attr);
    });

}

function create_default_nmat_graph() {
    var graph = m_graph.create();
    var input_color = {
        default_value: new Float32Array([0, 0, 0]),
        identifier: "Color",
        is_linked: false,
        name: "Color"
    };
    var input_alpha = {
        default_value: 1,
        identifier: "Alpha",
        is_linked: false,
        name: "Alpha"
    }
    var node = {
        data: null,
        dirs: [],
        params: [],
        inputs: [input_color, input_alpha],
        outputs: [],
        type: "OUTPUT",
        vparams: []
    };
    m_graph.append_node(graph, 0, node);
    return graph;
}

function clone_nmat_graph(graph) {
    return m_graph.clone(graph, clone_nmat_node, clone_nmat_edge_attr);
}

function clean_sockets_linked_property(graph) {
    m_graph.traverse(graph, function(id, node) {
        var inputs  = node.inputs;
        var outputs = node.outputs;

        for (var i = 0; i < inputs.length; i++)
            fix_socket_property(graph, inputs[i], id, i, 1);

        for (var i = 0; i < outputs.length; i++)
            fix_socket_property(graph, outputs[i], id, i, 0);
    });
}

function fix_socket_property(graph, connection, id, num, check_in_edge) {

    if (connection.is_linked) {
        var clear_linked = true;

        m_graph.traverse_edges(graph, function(in_edge, out_edge, sockets) {
            if ((!check_in_edge && in_edge == id && sockets[0] == num) ||
                (check_in_edge && out_edge == id && sockets[1] == num))
                clear_linked = false;
        });

        if (clear_linked)
            connection.is_linked = false;
    }
}

function fix_socket_types(graph, mat_name, shader_type) {
    var edge_data = [];
    m_graph.traverse_edges(graph, function(in_edge, out_edge, sockets) {
        var in_node = m_graph.get_node_attr(graph, in_edge);
        var out_node = m_graph.get_node_attr(graph, out_edge);

        var is_output_vec = m_util.is_vector(in_node.outputs[sockets[0]].default_value);
        var is_input_vec = m_util.is_vector(out_node.inputs[sockets[1]].default_value);
        if (is_output_vec != is_input_vec) {
            var trans_node;
            var vector = {
                "default_value": [0, 0, 0],
                "identifier": "Vector",
                "is_linked": true,
                "name": "Vector"
            };

            var value = {
                "default_value": 0,
                "identifier": "Value",
                "is_linked": true,
                "name": "Value"
            }

            if (is_output_vec && !is_input_vec)
                trans_node = init_bpy_node("vector_to_scalar", "B4W_VECTOSCAL",
                        [vector], [value]);
            else if (!is_output_vec && is_input_vec)
                trans_node = init_bpy_node("scalar_to_vector", "B4W_SCALTOVEC",
                        [value], [vector]);

            append_nmat_node(graph, trans_node, 0, mat_name, shader_type);
            edge_data.push([in_edge, out_edge, graph.nodes[graph.nodes.length - 2], sockets])
        }
    });

    for (var i = 0; i < edge_data.length; ++i) {
        m_graph.remove_edge_by_attr(graph, edge_data[i][0], edge_data[i][1], edge_data[i][3]);
        m_graph.append_edge(graph, edge_data[i][0], edge_data[i][2], [edge_data[i][3][0], 0]);
        m_graph.append_edge(graph, edge_data[i][2], edge_data[i][1], [0, edge_data[i][3][1]]);
    }
}

/**
 * Adding special edges to graph
 */
function complete_edges(graph) {
    var appended_edges = [];

    m_graph.traverse(graph, function(id, attr) {
        switch (attr.type) {
        case "B4W_TRANSLUCENCY":
            m_graph.traverse_edges(graph, function(edge_from, edge_to, edge_attr) {
                var attr_to = m_graph.get_node_attr(graph, edge_to);
                if (edge_from == id && attr_to.type == "MATERIAL_EXT") {
                    var from_socket_index = edge_attr[0];
                    if (attr.outputs[from_socket_index].name == "Translucency")
                        appended_edges.push(edge_from, edge_to, [edge_attr[0] + 1,
                                edge_attr[1] + 1]);
                }
            });
            break;
        }
    });
    for (var i = 0; i < appended_edges.length; i += 3)
        m_graph.append_edge(graph, appended_edges[i], appended_edges[i + 1],
                appended_edges[i + 2]);
}

function nmat_node_ids(bpy_node, graph) {

    var node_ids = [];

    m_graph.traverse(graph, function(id, attr) {
        if (attr.name == bpy_node["name"])
            node_ids.push(id);
    });

    if (node_ids.length)
        return node_ids;
    else
        m_util.panic("Node not found");
}

function nmat_cleanup_graph(graph) {
    var id_attr = [];
    // collect
    m_graph.traverse(graph, function(id, attr) {
        if (attr.type == "B4W_PARALLAX" || attr.type == "REROUTE")
            id_attr.push(id, attr);
    });

    for (var i = 0; i < id_attr.length; i+=2) {
        var id = id_attr[i];
        var attr = id_attr[i+1];
        if (attr.type == "B4W_PARALLAX")
            process_parallax_texture(graph, id, attr);

        else if(attr.type == "REROUTE") {
            var input_id = m_graph.get_in_edge(graph, id, 0);
            var out_edge_count = m_graph.out_edge_count(graph, id);
            var removed_edges  = [];
            var output_ids     = [];
            var edges_quantity = [];

            for (var j = 0; j < out_edge_count; j++) {
                var output_id = m_graph.get_out_edge(graph, id, j);
                var id_place  = output_ids.indexOf(output_id);

                // replace deff values
                var edge_num = id_place >= 0 ? edges_quantity[id_place] : 0;
                var rem_edge = m_graph.get_edge_attr(graph, id, output_id,
                        edge_num);
                if (rem_edge) {
                    var out_soc_num = rem_edge[1];
                    var def_value = attr.inputs[0].default_value;
                    var out_node = m_graph.get_node_attr(graph, output_id);
                    var input = out_node.inputs[out_soc_num];
                    switch(typeof(def_value)) {
                    case "number":
                        if (typeof(input.default_value) == "object") {
                            var vec = input.default_value;
                            for (var k = 0; k < vec.length; k++)
                                vec[k] = def_value;
                        } else if (typeof(input.default_value) == "number")
                            input.default_value = def_value;
                        break;
                    case "object":
                        if (typeof(input.default_value) == "object") {
                            var vec = input.default_value;
                            for (var k = 0; k < vec.length; k++)
                                vec[k] = def_value[k];
                        } else if (typeof(input.default_value) == "number")
                            input.default_value = 0.35 * def_value[0] + 0.45 * def_value[1]
                                + 0.2 * def_value[2];
                        break;
                    }
                }

                var outputs = attr.outputs;
                for (var k = 0; k < outputs.length; k++)
                    outputs[k].default_value = attr.inputs[0].default_value;

                if (id_place != -1)
                    edges_quantity[id_place] += 1;
                else {
                    output_ids.push(output_id);
                    edges_quantity.push(1);
                    removed_edges.push(id, output_id);
                }
            }

            if (input_id != -1) {
                var from_index = m_graph.get_edge_attr(graph, input_id, id, 0)[0];

                for (var j = 0; j < output_ids.length; j++) {
                    for (var k = 0; k < edges_quantity[j]; k++) {
                        var to_index = m_graph.get_edge_attr(graph, id, output_ids[j], k)[1];

                        m_graph.append_edge(graph, input_id, output_ids[j], [from_index, to_index]);
                    }
                }
            }

            for (var j = 0; j < removed_edges.length; j +=2)
                m_graph.remove_edge(graph, removed_edges[j], removed_edges[j+1], -1);
        }
    }
}

function process_parallax_texture(graph, id, attr) {
    var input_id1 = get_in_edge_by_input_num(graph, id, 1);
    if (input_id1 != -1) {

        // steal texture from the input texture node
        var input1_attr = m_graph.get_node_attr(graph, input_id1);
        attr.data = input1_attr.data;

        // remove edges
        m_graph.remove_edge(graph, input_id1, id, -1);
        if (m_graph.out_edge_count(graph, input_id1) == 0) {
            var input_input_id = m_graph.get_in_edge(graph, input_id1, 0);
            if (input_input_id != -1)
                m_graph.remove_edge(graph, input_input_id, input_id1, -1);
            m_graph.remove_node(graph, input_id1);
        }
    }
    // remove HeightMap(color) input
    attr.inputs.splice(1, 1);
}

function get_in_edge_by_input_num(graph, node, input_num) {
    var edges = graph.edges;

    for (var i = 0; i < edges.length; i+=3) {
        if (edges[i+1] == node) {
            var num = edges[i+2][1];
            if (num == input_num)
                return edges[i];
        }
    }
    return -1;
}

function merge_nodes(graph) {
    merge_geometry(graph);
    merge_textures(graph);
    merge_uvs(graph);
    // merge_displacement_values_and_rgb(graph);
}

function merge_uvs(graph, shader_type) {

    var uv_counter = {};
    m_graph.traverse(graph, function(id, attr) {
        if (attr.type == "GEOMETRY_UV" || attr.type == "UVMAP"
                || attr.type == "TEX_COORD_UV") {
            var uv_name = attr.data.value;
            if (!(uv_name in uv_counter))
                uv_counter[uv_name] = [];
            uv_counter[uv_name].push(id, attr);
        }
    });

    for (var uv_name in uv_counter) {
        var id_attr = uv_counter[uv_name];

        //NOTE: we don't need to merge single UVs
        if (id_attr.length > 2) {
            var bpy_node = create_uv_merged_bpy_node(uv_name);
            var node_id = append_nmat_node(graph, bpy_node, 0, "", shader_type);
            var node = m_graph.get_node_attr(graph, node_id);

            for (var i = 0; i < id_attr.length; i+=2) {
                var id = id_attr[i];
                var attr = id_attr[i + 1];

                var removed_edges = [];
                
                var edges_out_counter = {};
                var out_num = m_graph.out_edge_count(graph, id);
                for (var j = 0; j < out_num; j++) {
                    var out_id = m_graph.get_out_edge(graph, id, j);

                    if (!(out_id in edges_out_counter))
                        edges_out_counter[out_id] = 0;

                    var edge_attr = m_graph.get_edge_attr(graph, id, out_id,
                            edges_out_counter[out_id]);
                    edges_out_counter[out_id]++;

                    removed_edges.push(id, out_id, edge_attr);

                    var new_edge_attr = edge_attr.splice(0, edge_attr.length);
                    switch (attr.type) {
                        case "GEOMETRY_UV":
                            new_edge_attr[0] = 0;
                            node.outputs[0].is_linked = true;
                            break;
                        case "UVMAP":
                        case "TEX_COORD_UV":
                            new_edge_attr[0] = 1;
                            node.outputs[1].is_linked = true;
                            break;
                    }
                    m_graph.append_edge(graph, node_id, out_id, new_edge_attr);
                }

                for (var j = 0; j < removed_edges.length; j += 3)
                    m_graph.remove_edge(graph, removed_edges[j],
                            removed_edges[j + 1], 0);

                m_graph.remove_node(graph, id);
            }
        }
    }
}

function create_uv_merged_bpy_node(uv_name) {
    var UV_geom = {
        "default_value": [0, 0, 0],
        "identifier": "UV_geom",
        "is_linked": false,
        "name": "UV_geom"
    };
    var UV_cycles = {
        "default_value": [0, 0, 0],
        "identifier": "UV_cycles",
        "is_linked": false,
        "name": "UV_cycles"
    };

    var node = init_bpy_node("merged_uv", "UV_MERGED", [], [UV_geom, UV_cycles]);
    node["uv_layer"] = uv_name;

    return node;
}

function merge_geometry(graph) {

    var id_attr = [];
    m_graph.traverse(graph, function(id, attr) {
        if (attr.type == "GEOMETRY_VC" || attr.type == "GEOMETRY_NO"
                || attr.type == "GEOMETRY_FB" || attr.type == "GEOMETRY_VW"
                || attr.type == "GEOMETRY_GL" || attr.type == "GEOMETRY_LO"
                || attr.type == "GEOMETRY_OR" || attr.type == "GEOMETRY_BF"
                || attr.type == "GEOMETRY_IN")
            id_attr.push(id, attr);
    });

    var unique_nodes = [];

    for (var i = 0; i < id_attr.length; i+=2) {
        var id_current = id_attr[i];
        var attr_current = id_attr[i+1];

        var is_unique = true;

        for (var j = 0; j < unique_nodes.length; j++) {
            var unode = unique_nodes[j];

            // check nodes coincidence
            if (can_merge_nodes(attr_current, unode.attr)) {

                var removed_edges = [];
                var out_num = m_graph.out_edge_count(graph, id_current);

                // process every outgoing edge
                for (var k = 0; k < out_num; k++) {
                    var out_id = m_graph.get_out_edge(graph, id_current, k);
                    var edge_attr = m_graph.get_edge_attr(graph, id_current, out_id, 0);

                    // removing edges affects graph traversal
                    removed_edges.push(id_current, out_id, edge_attr);

                    m_graph.append_edge(graph, unode.id, out_id, edge_attr);
                }

                for (var k = 0; k < removed_edges.length; k += 3)
                    m_graph.remove_edge(graph, removed_edges[k],
                            removed_edges[k + 1], 0);

                m_graph.remove_node(graph, id_current);

                is_unique = false;
                break;
            }
        }

        if (is_unique) {
            var unode = {
                id: id_current,
                attr: attr_current
            }
            unique_nodes.push(unode);
        }
    }
}

function merge_displacement_values_and_rgb(graph) {
    var id_attr = [];
    m_graph.traverse(graph, function(id, attr) {
        if (attr.type == "RGB" || attr.type == "VALUE")
            id_attr.push(id, attr);
    });

    var unique_nodes = [];

    for (var i = 0; i < id_attr.length; i+=2) {
        var id_current = id_attr[i];
        var attr_current = id_attr[i+1];

        var is_unique = true;

        for (var j = 0; j < unique_nodes.length; j++) {
            var unode = unique_nodes[j];

            // check nodes coincidence
            if (can_merge_nodes(attr_current, unode.attr)) {

                var removed_edges = [];
                var out_num = m_graph.out_edge_count(graph, id_current);

                // process every outgoing edge
                for (var k = 0; k < out_num; k++) {
                    var out_id = m_graph.get_out_edge(graph, id_current, k);
                    var edge_attr = m_graph.get_edge_attr(graph, id_current, out_id, 0);

                    // removing edges affects graph traversal
                    removed_edges.push(id_current, out_id, edge_attr);

                    m_graph.append_edge(graph, unode.id, out_id, edge_attr);
                }

                for (var k = 0; k < removed_edges.length; k += 3)
                    m_graph.remove_edge(graph, removed_edges[k],
                            removed_edges[k + 1], 0);

                m_graph.remove_node(graph, id_current);

                is_unique = false;
                break;
            }
        }

        if (is_unique) {
            attr_current.name = dsp_stripped_node_name(attr_current);
            var unode = {
                id: id_current,
                attr: attr_current
            };
            unique_nodes.push(unode);
        }
    }
}

function dsp_stripped_node_name(node) {
    return node.name.replace(/displacement%join%/, "");
}

function get_nodes_ascendants(graph) {
    var nodes_ascendants = {};

    for (var i = 0; i < graph.nodes.length; i += 2) {
        var id = graph.nodes[i];
        nodes_ascendants[id] = { ascs_ids: {}, is_completed: false };
    }

    // collect nearest parent for each node
    for (var i = 0; i < graph.edges.length; i += 3) {
        var id_from = graph.edges[i];
        var id_to = graph.edges[i + 1];
        nodes_ascendants[id_to].ascs_ids[id_from] = true;
    }

    // collect all the ascendants
    for (var id in nodes_ascendants)
        collect_node_ascs(id, nodes_ascendants);

    for (var id in nodes_ascendants)
        nodes_ascendants[id] = Object.keys(nodes_ascendants[id].ascs_ids).map(function(str){return parseInt(str, 10)});

    return nodes_ascendants;
}

function collect_node_ascs(node_id, nodes_ascendants) {
    var node = nodes_ascendants[node_id];

    if (!node.is_completed) {
        var node_clone = m_util.clone_object_r(node);
        
        for (var asc_id in node.ascs_ids) {
            collect_node_ascs(asc_id, nodes_ascendants);
            var asc_node = nodes_ascendants[asc_id];
            for (var asc_asc_id in asc_node.ascs_ids)
                node_clone.ascs_ids[asc_asc_id] = true;
        }

        node_clone.is_completed = true;
        nodes_ascendants[node_id] = node_clone;
    }
}

function merge_textures(graph) {

    var id_attr = [];
    m_graph.traverse(graph, function(id, attr) {
        if (attr.type == "TEXTURE_COLOR" || attr.type == "TEXTURE_NORMAL")
            id_attr.push(id, attr);
    });

    if (!id_attr.length)
        return;

    var ascs = get_nodes_ascendants(graph);

    var unique_nodes = [];

    for (var i = 0; i < id_attr.length; i+=2) {
        var id_current = id_attr[i];
        var attr_current = id_attr[i+1];

        var is_unique = true;

        for (var j = 0; j < unique_nodes.length; j++) {
            var unode = unique_nodes[j];

            // NOTE: every 4 texture nodes merged: first found (main) and others
            if (unode.merged_nodes.length >= 3)
                continue;

            // check nodes coincidence
            if (!can_merge_nodes(attr_current, unode.attr))
                continue;

            // merged nodes can't be reachable from the each other in a directed graph
            if (ascs[id_current].indexOf(unode.id) > -1 ||
                    ascs[unode.id].indexOf(id_current) > -1)
                continue;
            var is_reachable = false;
            for (var k = 0; k < unode.merged_nodes.length; k++) {
                var merged_id = unode.merged_nodes[k].id;
                if (ascs[id_current].indexOf(merged_id) > -1 ||
                    ascs[merged_id].indexOf(id_current) > -1) {
                    is_reachable = true;
                    break;
                }
            }
            if (is_reachable)
                continue;

            var removed_edges_in = [];
            var in_num = m_graph.in_edge_count(graph, id_current);

            // process every ingoing edge
            var edges_in_counter = {}
            for (k = 0; k < in_num; k++) {
                var in_id = m_graph.get_in_edge(graph, id_current, k);

                if (!(in_id in edges_in_counter))
                    edges_in_counter[in_id] = 0;
                var edge_attr = m_graph.get_edge_attr(graph, in_id,
                        id_current, edges_in_counter[in_id]++);

                // removing edges affects graph traversal; save edge_attr
                // for further merging
                removed_edges_in.push(in_id, id_current, edge_attr);
            }

            var removed_edges_out = [];
            var out_num = m_graph.out_edge_count(graph, id_current);

            // process every outgoing edge
            var edges_out_counter = {}
            for (k = 0; k < out_num; k++) {
                var out_id = m_graph.get_out_edge(graph, id_current, k);

                if (!(out_id in edges_out_counter))
                    edges_out_counter[out_id] = 0;
                var edge_attr = m_graph.get_edge_attr(graph, id_current,
                        out_id, edges_out_counter[out_id]++);

                // removing edges affects graph traversal; save edge_attr
                // for further merging
                removed_edges_out.push(id_current, out_id, edge_attr);
            }

            var removed_edges = removed_edges_in.concat(removed_edges_out);
            for (var k = 0; k < removed_edges.length; k += 3)
                m_graph.remove_edge(graph, removed_edges[k],
                        removed_edges[k + 1], 0);
            m_graph.remove_node(graph, id_current);

            var mnode = {
                id: id_current,
                attr: attr_current,
                edges_in: removed_edges_in,
                edges_out: removed_edges_out
            }
            unode.merged_nodes.push(mnode);

            is_unique = false;
            break;
        }

        if (is_unique) {
            var unode = {
                id: id_current,
                attr: attr_current,
                merged_nodes: []
            }
            unique_nodes.push(unode);
        }
    }

    // NOTE: merge texture nodes data
    for (var i = 0; i < unique_nodes.length; i++) {
        var unode = unique_nodes[i];

        var mnodes_count = unode.merged_nodes.length;

        // NOTE: merge similar nodes and unique node
        for (var j = 0; j < mnodes_count; j++) {
            var merged_data = unode.merged_nodes[j];
            var mnode = merged_data.attr;
            var edges_in = merged_data.edges_in;
            var edges_out = merged_data.edges_out;

            unode.attr.inputs[j + 1].is_linked = mnode.inputs[0].is_linked;
            unode.attr.inputs[j + 1].default_value = mnode.inputs[0].default_value;
            unode.attr.outputs[2 * (j + 1)].is_linked = mnode.outputs[0].is_linked;
            unode.attr.outputs[2 * (j + 1)].default_value = mnode.outputs[0].default_value;
            unode.attr.outputs[2 * (j + 1) + 1].is_linked = mnode.outputs[1].is_linked;
            unode.attr.outputs[2 * (j + 1) + 1].default_value = mnode.outputs[1].default_value;

            // NOTE: change edge attributes indices for similar links
            for (var k = 0; k < edges_in.length; k += 3) {
                var in_id = edges_in[k];
                var edge_attr = edges_in[k + 2];
                edge_attr[1] += (j + 1);
                m_graph.append_edge(graph, in_id, unode.id, edge_attr);
            }

            for (var k = 0; k < edges_out.length; k += 3) {
                var out_id = edges_out[k + 1];
                var edge_attr = edges_out[k + 2];
                edge_attr[0] += (j + 1) * 2;
                m_graph.append_edge(graph, unode.id, out_id, edge_attr);
            }

            unode.attr.dirs.push(["USE_uv" + (j + 2), 1]);
        }

        m_graph.remove_node(graph, unode.id);
        m_graph.append_node(graph, unode.id, unode.attr);
    }
}

function can_merge_nodes(attr1, attr2) {
    if (attr1.type !== attr2.type)
        return false;

    switch (attr1.type) {
    case "GEOMETRY_VC":
        return attr1.data.value == attr2.data.value;
    case "GEOMETRY_NO":
        return check_dir_value_identity(attr1, attr2, "USE_NORMAL_IN");
    case "GEOMETRY_FB":
    case "GEOMETRY_VW":
    case "GEOMETRY_GL":
    case "GEOMETRY_LO":
    case "GEOMETRY_OR":
    case "GEOMETRY_BF":
    case "GEOMETRY_IN":
        return true;
    case "TEXTURE_COLOR":
    case "TEXTURE_NORMAL":
        return attr1.data.bpy_uuid == attr2.data.bpy_uuid &&
               // NOTE: Cycles textures are merged depending on images uuid
               attr1.data.value.img_uuid == attr2.data.value.img_uuid;
    case "VALUE":
    case "RGB":
        return attr1.origin_name == attr2.origin_name; 
    default:
        return false;
    }
}

function check_dir_value_identity(node1, node2, dir_name) {
    var dirs1 = node1.dirs
    var dir1_value = -1;
    for (var i = 0; i < dirs1.length; i++) {
        var dir1 = dirs1[i];
        if (dir1[0] == dir_name) {
            dir1_value = dir1[1];
            break;
        }
    }

    var dirs2 = node2.dirs
    var dir2_value = -1;
    for (var i = 0; i < dirs2.length; i++) {
        var dir2 = dirs2[i];
        if (dir2[0] == dir_name) {
            dir2_value = dir2[1];
            break;
        }
    }

    return dir1_value === dir2_value;
}

// NOTE: unused
function can_merge_nodes_uv(attr1, attr2) {
    var permissible_types = ["GEOMETRY_UV", "TEX_COORD_UV", "UVMAP"];
    if (permissible_types.indexOf(attr1.type) != -1
            && permissible_types.indexOf(attr2.type) != -1)
        return attr1.data.value == attr2.data.value;
    return false;
}

function optimize_geometry(graph) {
    var id_attr_vc = [];
    var id_attr_vw = [];

    m_graph.traverse(graph, function(id, attr) {
        if (attr.type == "GEOMETRY_VC")
            id_attr_vc.push(id, attr);
        if (attr.type == "GEOMETRY_VW")
            id_attr_vw.push(id, attr);
    });

    optimize_geometry_vcol(graph, id_attr_vc);
    optimize_geometry_view(graph, id_attr_vw);
}

function optimize_geometry_vcol(graph, id_attr_vc) {
    for (var i = 0; i < id_attr_vc.length; i+=2) {
        var geom_id = id_attr_vc[i];
        var geom_attr = id_attr_vc[i+1];

        var need_optimize = false;
        var removed_edges = [];
        var removed_seprgb_nodes = [];
        var channels_usage = [[], [], []];

        var geometry_out_num = m_graph.out_edge_count(graph, geom_id);
        for (var j = 0; j < geometry_out_num; j++) {
            var out_id = m_graph.get_out_edge(graph, geom_id, j);
            var out_node = m_graph.get_node_attr(graph, out_id);

            // optimize if it has only SEPRGB nodes as outputs
            if (out_node.type != "SEPRGB") {
                need_optimize = false;
                break;
            }

            removed_edges.push(geom_id, out_id);

            var edges_out_num = {}
            var seprgb_out_num = m_graph.out_edge_count(graph, out_id);
            for (var k = 0; k < seprgb_out_num; k++) {

                var seprgb_out_id = m_graph.get_out_edge(graph, out_id, k);
                if (!(seprgb_out_id in edges_out_num))
                    edges_out_num[seprgb_out_id] = 0;

                var edge_attr = m_graph.get_edge_attr(graph, out_id,
                        seprgb_out_id, edges_out_num[seprgb_out_id]++);

                removed_edges.push(out_id, seprgb_out_id);
                channels_usage[edge_attr[0]].push(geom_id, seprgb_out_id, edge_attr);

            }

            removed_seprgb_nodes.push(out_id);
            need_optimize = true;
        }

        if (need_optimize) {
            var channels_count = 0;
            var mask = 0;
            for (var j = 0; j < channels_usage.length; j++)
                if (channels_usage[j].length) {
                    channels_count++;
                    mask |= 1 << (2 - j);
                }

            if (channels_count) {
                // change GEOMETRY_VC outputs and type
                geom_attr.type += channels_count;

                geom_attr.outputs = [];
                for (var j = 0; j < channels_usage.length; j++) {
                    if (channels_usage[j].length) {
                        geom_attr.outputs.push({
                            default_value: 0,
                            identifier: "RGB"[j],
                            is_linked: true,
                            name: "RGB"[j]
                        });
                        for (var k = 0; k < channels_usage[j].length; k += 3)
                            channels_usage[j][k + 2][0]
                                    = m_util.rgb_mask_get_channel_presence_index(
                                    mask, j);
                    }
                }

                // remove unused edges
                for (var j = 0; j < removed_edges.length; j += 2)
                    m_graph.remove_edge(graph, removed_edges[j],
                            removed_edges[j + 1], 0);

                // remove SEPRGB nodes
                for (var j = 0; j < removed_seprgb_nodes.length; j++)
                    m_graph.remove_node(graph, removed_seprgb_nodes[j]);

                // add new edges
                for (var j = 0; j < channels_usage.length; j++)
                    for (var k = 0; k < channels_usage[j].length; k += 3)
                        m_graph.append_edge(graph, channels_usage[j][k],
                                channels_usage[j][k + 1], channels_usage[j][k + 2]);
            }
        }

    }
}

function optimize_geometry_view(graph, id_attr_vw) {
    for (var i = 0; i < id_attr_vw.length; i+=2) {
        var geom_id = id_attr_vw[i];

        var need_remove_geom_vw = true;
        var optimized_node_pairs = [];

        var geometry_out_num = m_graph.out_edge_count(graph, geom_id);
        for (var j = 0; j < geometry_out_num; j++) {
            var out_id = m_graph.get_out_edge(graph, geom_id, j);
            var out_node = m_graph.get_node_attr(graph, out_id);

            // delete GEOMETRY_VW if it has only B4W_REFLECT nodes as outputs
            if (out_node.type == "B4W_REFLECT") {
                // maximum two edges between GEOMETRY_VC and B4W_REFLECT
                var edge_attr1 = m_graph.get_edge_attr(graph, geom_id, out_id, 0);
                var edge_attr2 = m_graph.get_edge_attr(graph, geom_id, out_id, 1);

                // optimize if GEOMETRY_VC used only in the first B4W_REFLECT input
                if (edge_attr1 && edge_attr1[1] == 1 || edge_attr2 && edge_attr2[1] == 1)
                    need_remove_geom_vw = false;
                else
                    optimized_node_pairs.push(geom_id, out_id);
            } else
                need_remove_geom_vw = false;
        }

        // optimize B4W_REFLECT nodes
        for (var j = 0; j < optimized_node_pairs.length; j += 2)
            optimize_reflect_node(graph, optimized_node_pairs[j], optimized_node_pairs[j+1]);

        // remove GEOMETRY_VW node
        if (need_remove_geom_vw)
            m_graph.remove_node(graph, geom_id);
    }
}

function optimize_reflect_node(graph, geom_id, refl_id) {
    var refl_node = m_graph.get_node_attr(graph, refl_id);
    refl_node.type += "_WORLD";

    // remove unused edge
    m_graph.remove_edge(graph, geom_id, refl_id, 0);

    // remove unused node input and correct the second edge
    refl_node.inputs.splice(0, 1);
    var in_id = m_graph.get_in_edge(graph, refl_id, 0);
    if (in_id != m_graph.NULL_NODE) {
        var edge_attr = m_graph.get_edge_attr(graph, in_id, refl_id, 0);
        edge_attr[1] = 0;
    }
}

function find_node_id(node_tree, graph, type, source_type, is_group_node,
        suppress_errors) {
    var bpy_nodes = node_tree["nodes"];

    // find last OUTPUT
    var last_output_node = null;

    // search in original bpy_nodes
    for (var i = 0; i < bpy_nodes.length; i++) {
        var bpy_node = bpy_nodes[i];

        if (is_group_node) {
            if (bpy_node["type"] == "GROUP" && bpy_node["node_tree_name"] == type)
                last_output_node = bpy_node;
        } else {
            if (bpy_node["type"] == type)
                last_output_node = bpy_node;
        }
    }

    if (!last_output_node) {
        if (!suppress_errors)
            m_print.error("No \"" + type + "\" node in node " + source_type);
        return -1;
    }

    // seems always unique
    return nmat_node_ids(last_output_node, graph)[0];
}

function init_bpy_node(name, type, inputs, outputs) {
    var node = {
        "name": name,
        "type": type,
        "inputs": inputs,
        "outputs": outputs
    }
    return node;
}

function init_bpy_link(from_node, from_socket, to_node, to_socket) {
    var link = {
        "from_node": from_node,
        "from_socket": from_socket,
        "to_node": to_node,
        "to_socket": to_socket
    }
    return link;
}

function create_nmat_node() {
    var nmat_node = {
        name: "",
        origin_name: "",
        type: "",

        vparams: [],

        inputs: [],
        outputs: [],
        params: [],

        data: null,

        dirs: []
    };
    return nmat_node;
}

function clone_nmat_node(nmat_node) {
    var new_nmat_node = create_nmat_node();

    new_nmat_node.name = nmat_node.name;
    new_nmat_node.origin_name = nmat_node.origin_name;
    new_nmat_node.type = nmat_node.type;

    var new_vparams = new_nmat_node.vparams;
    var vparams = nmat_node.vparams;
    for (var i = 0; i < vparams.length; i++) {
        var vparam = vparams[i];
        new_vparams.push(clone_node_param(vparam));
    }
    var new_params = new_nmat_node.params;
    var params = nmat_node.params;
    for (var i = 0; i < params.length; i++) {
        var param = params[i];
        new_params.push(clone_node_param(param));
    }

    var new_inputs = new_nmat_node.inputs;
    var inputs = nmat_node.inputs;
    for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i];
        new_inputs.push(clone_node_inout(input));
    }
    var new_outputs = new_nmat_node.outputs;
    var outputs = nmat_node.outputs;
    for (var i = 0; i < outputs.length; i++) {
        var output = outputs[i];
        new_outputs.push(clone_node_inout(output));
    }

    var new_dirs = new_nmat_node.dirs;
    var dirs = nmat_node.dirs;
    for (var i = 0; i < dirs.length; i++) {
        var dir = dirs[i];
        new_dirs.push(dir.slice());
    }

    new_nmat_node.data = nmat_node.data;

    return new_nmat_node;
}

function append_nmat_node(graph, bpy_node, output_num, mat_name, shader_type) {
    var name = bpy_node["name"];
    var origin_name = bpy_node["name"];
    var type = bpy_node["type"];
    var vparams = [];
    var inputs = [];
    var outputs = [];
    var params = [];

    var data = null;

    var dirs = [];
    switch (type) {
    case "BSDF_ANISOTROPIC":
    case "BSDF_GLASS":
    case "BSDF_HAIR":
    case "BSDF_TRANSLUCENT":
    case "BSDF_REFRACTION":
    case "BSDF_TOON":
    case "BSDF_VELVET":
    case "SUBSURFACE_SCATTERING":
    case "AMBIENT_OCCLUSION":
    case "VOLUME_ABSORPTION":
    case "VOLUME_SCATTER":
    case "BLACKBODY":
    case "WAVELENGTH":
    case "SEPXYZ":
    case "COMBXYZ":
    case "LIGHT_FALLOFF":
    case "TEX_SKY":
    case "TEX_NOISE":
    case "TEX_WAVE":
    case "TEX_MUSGRAVE":
    case "TEX_GRADIENT":
    case "TEX_MAGIC":
    case "TEX_CHECKER":
    case "TEX_BRICK":
    case "WIREFRAME":
    case "TANGENT":
    case "LIGHT_PATH":
    case "ATTRIBUTE":
    case "HOLDOUT":
    case "HAIR_INFO":
    case "SCRIPT":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        m_print.warn(type + " node is not fully supported.");
        break;
    case "BRIGHTCONTRAST":
    case "ADD_SHADER":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        break;
    case "MIX_SHADER":
        inputs.push(node_input_by_ident(bpy_node, "Fac"));
        var shader_input = node_input_by_ident(bpy_node, "Shader");
        var shader_input_is_linked = shader_input.is_linked;
        inputs.push(shader_input);
        var shader1_input = node_input_by_ident(bpy_node, "Shader_001");
        // backward compatibility with old blend files
        if (!shader1_input)
            shader1_input = node_input_by_ident(bpy_node, "Shader.001");
        var shader1_input_is_linked = shader1_input.is_linked;
        inputs.push(shader1_input);

        inputs.push(default_node_inout("d_color1", "d_color1", [0, 0, 0], shader_input_is_linked));
        inputs.push(default_node_inout("d_roughness1", "d_roughness1", 0, shader_input_is_linked));
        inputs.push(default_node_inout("s_color1", "s_color1", [0, 0, 0], shader_input_is_linked));
        inputs.push(default_node_inout("s_roughness1", "s_roughness1", 0, shader_input_is_linked));
        inputs.push(default_node_inout("metalness1", "metalness1", 0, shader_input_is_linked));
        inputs.push(default_node_inout("normal1", "normal1", [0, 0, 0], shader_input_is_linked));
        inputs.push(default_node_inout("e_color1", "e_color1", [0, 0, 0], shader_input_is_linked));
        inputs.push(default_node_inout("emission1", "emission1", 0, shader_input_is_linked));
        inputs.push(default_node_inout("a_color1", "a_color1", [0, 0, 0], shader_input_is_linked));
        inputs.push(default_node_inout("alpha1", "alpha1", 1, shader_input_is_linked));

        inputs.push(default_node_inout("d_color2", "d_color2", [0, 0, 0], shader1_input_is_linked));
        inputs.push(default_node_inout("d_roughness2", "d_roughness2", 0, shader1_input_is_linked));
        inputs.push(default_node_inout("s_color2", "s_color2", [0, 0, 0], shader1_input_is_linked));
        inputs.push(default_node_inout("s_roughness2", "s_roughness2", 0, shader1_input_is_linked));
        inputs.push(default_node_inout("metalness2", "metalness2", 0, shader1_input_is_linked));
        inputs.push(default_node_inout("normal2", "normal2", [0, 0, 0], shader1_input_is_linked));
        inputs.push(default_node_inout("e_color2", "e_color2", [0, 0, 0], shader1_input_is_linked));
        inputs.push(default_node_inout("emission2", "emission2", 0, shader1_input_is_linked));
        inputs.push(default_node_inout("a_color2", "a_color2", [0, 0, 0], shader1_input_is_linked));
        inputs.push(default_node_inout("alpha2", "alpha2", 1, shader1_input_is_linked));

        var shader_output = node_output_by_ident(bpy_node, "Shader");
        var shader_output_is_linked = shader_output.is_linked;
        outputs = [shader_output,
                   default_node_inout("d_color", "d_color", [0, 0, 0], shader_output_is_linked),
                   default_node_inout("d_roughness", "d_roughness", 0, shader_output_is_linked),
                   default_node_inout("s_color", "s_color", [0, 0, 0], shader_output_is_linked),
                   default_node_inout("s_roughness", "s_roughness", 0, shader_output_is_linked),
                   default_node_inout("metalness", "metalness", 0, shader_output_is_linked),
                   default_node_inout("normal", "normal", [0, 0, 0], shader_output_is_linked),
                   default_node_inout("e_color", "e_color", [0, 0, 0], shader_output_is_linked),
                   default_node_inout("emission", "emission", 0, shader_output_is_linked),
                   default_node_inout("a_color", "a_color", [0, 0, 0], shader_output_is_linked),
                   default_node_inout("alpha", "alpha", 1, shader_output_is_linked)];
        break;
    case "OBJECT_INFO":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = [];
        var output_location = node_output_by_ident(bpy_node, "Location");
        var output_obj_ind = node_output_by_ident(bpy_node, "Object Index");
        var output_mat_ind = node_output_by_ident(bpy_node, "Material Index");
        var output_random = node_output_by_ident(bpy_node, "Random");
        outputs.push(output_location);
        outputs.push(output_obj_ind);
        outputs.push(output_mat_ind);
        outputs.push(output_random);
        dirs.push(["USE_LOCATION_OUT", output_location.is_linked | 0]);
        dirs.push(["USE_OBJ_IND_OUT", output_obj_ind.is_linked | 0]);
        dirs.push(["USE_MAT_IND_OUT", output_mat_ind.is_linked | 0]);
        dirs.push(["USE_RANDOM_OUT", output_random.is_linked | 0]);
        break;
    case "UVMAP":
        var uv_layer = bpy_node["uv_layer"];
        if (!uv_layer)
            type = "EMPTY_UV";

        if (type != "EMPTY_UV") {
            var uv_name = shader_ident("param_" + type + "_a");
            var uv_tra_name = shader_ident("param_" + type + "_v");

            vparams.push(node_param(uv_name));
            vparams.push(node_param(uv_tra_name));

            params.push(node_param(uv_tra_name));

            data = {
                name: uv_name,
                value: uv_layer
            }
        }
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        break;
    case "UV_MERGED":
        var uv_name = shader_ident("param_UV_MERGED_a");
        var uv_tra_name = shader_ident("param_UV_MERGED_v");

        vparams.push(node_param(uv_name));
        vparams.push(node_param(uv_tra_name));

        outputs.push(node_output_by_ident(bpy_node, "UV_geom"));
        outputs.push(node_output_by_ident(bpy_node, "UV_cycles"));
        params.push(node_param(uv_tra_name));

        data = {
            name: uv_name,
            value: bpy_node["uv_layer"]
        }
        break;
    case "CAMERA":
        inputs = [];
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        break;
    case "COMBRGB":
    case "COMBHSV":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        break;
    case "CURVE_RGB":
    case "CURVE_VEC":
        if (type == "CURVE_RGB") {
            if (check_curve_usage(bpy_node, 0, 0.0, 1.0))
                dirs.push(["READ_R", 1]);
            if (check_curve_usage(bpy_node, 1, 0.0, 1.0))
                dirs.push(["READ_G", 1]);
            if (check_curve_usage(bpy_node, 2, 0.0, 1.0))
                dirs.push(["READ_B", 1]);
            if (check_curve_usage(bpy_node, 3, 0.0, 1.0))
                dirs.push(["READ_A", 1]);
        } else {
            if (check_curve_usage(bpy_node, 0, -1.0, 1.0))
                dirs.push(["READ_R", 1]);
            if (check_curve_usage(bpy_node, 1, -1.0, 1.0))
                dirs.push(["READ_G", 1]);
            if (check_curve_usage(bpy_node, 2, -1.0, 1.0))
                dirs.push(["READ_B", 1]);
        }
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        data = {
            value: bpy_node
        };
        break;
    case "PARTICLE_INFO":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        for (var k = 0; k < bpy_node["outputs"].length; k++) {
            var output = bpy_node["outputs"][k];
            var identifier = output["identifier"];
            var v_name = node_param("v_param_PART_INFO_" + identifier.replace(" ", ""));
            if (output["is_linked"]) {
                switch(identifier) {
                case "Size":
                    dirs.push(["PART_INFO_SIZE", m_shaders.glsl_value(1)]);
                    break;
                case "Age":
                    dirs.push(["PART_INFO_AGE", m_shaders.glsl_value(1)]);
                    break;
                case "Lifetime":
                    dirs.push(["PART_INFO_LT", m_shaders.glsl_value(1)]);
                    break;
                case "Location":
                    dirs.push(["PART_INFO_LOC", m_shaders.glsl_value(1)]);
                    break;
                case "Index":
                    var a_name = node_param("a_param_PART_INFO_" + output.identifier.replace(" ", ""));
                    data = a_name;
                    dirs.push(["PART_INFO_IND", m_shaders.glsl_value(1)]);
                    break;
                case "Velocity":
                    dirs.push(["PART_INFO_VEL", m_shaders.glsl_value(1)]);
                    break;
                case "Angular Velocity":
                    dirs.push(["PART_INFO_A_VEL", m_shaders.glsl_value(1)]);
                    break;
                }
            }
            if (identifier != "Age" && identifier != "Lifetime" && identifier != "Size") {
                vparams.push(v_name);
                params.push(v_name);
            }
        }
        if (a_name)
            vparams.push(a_name);
        break;
    case "NEW_GEOMETRY":
    case "GEOMETRY":

        if (!check_input_node_outputs(bpy_node))
            return true;

        type = geometry_node_type(bpy_node, output_num);
        if (!type) {
            m_print.error("Geometry output is not supported");
            return null;
        }

        switch (type) {
        case "GEOMETRY_UV":
            var curr_uv_layer = bpy_node["uv_layer"];
            if (!curr_uv_layer)
                type = "EMPTY_UV";

            if (type != "EMPTY_UV") {
                var uv_name = shader_ident("param_GEOMETRY_UV_a");
                var uv_tra_name = shader_ident("param_GEOMETRY_UV_v");

                vparams.push(node_param(uv_name));
                vparams.push(node_param(uv_tra_name));

                params.push(node_param(uv_tra_name));

                data = {
                    name: uv_name,
                    value: curr_uv_layer
                }
            }
            outputs.push(node_output_by_ident(bpy_node, "UV"));
            break;
        case "GEOMETRY_VC":
            var curr_color_layer = bpy_node["color_layer"];
            if (!curr_color_layer)
                type = "EMPTY_VC";

            if (type != "EMPTY_VC") {
                var vc_name = shader_ident("param_GEOMETRY_VC_a");
                var vc_tra_name = shader_ident("param_GEOMETRY_VC_v");

                vparams.push(node_param(vc_name));
                vparams.push(node_param(vc_tra_name));

                params.push(node_param(vc_tra_name));

                data = {
                    name: vc_name,
                    value: curr_color_layer
                }
            }
            outputs.push(node_output_by_ident(bpy_node, "Vertex Color"));
            break;
        case "GEOMETRY_NO":
            // fake input, used only with displacement_bump
            inputs.push(default_node_inout("Normal", "Normal", [0, 0, 0], false));
            dirs.push(["USE_NORMAL_IN", 0]);
            outputs.push(node_output_by_ident(bpy_node, "Normal"));
            break;
        case "GEOMETRY_TRN":
            type = "GEOMETRY_NO";
            // fake input, used only with displacement_bump
            inputs.push(default_node_inout("Normal", "Normal", [0, 0, 0], false));
            outputs.push(node_output_by_ident(bpy_node, "True Normal"));
            dirs.push(["USE_NORMAL_IN", 0]);
            m_print.warn("Geometry True Normal output is not fully supported.");
            break;
        case "GEOMETRY_FB":
            outputs.push(node_output_by_ident(bpy_node, "Front/Back"));
            break;
        case "GEOMETRY_VW":
            outputs.push(node_output_by_ident(bpy_node, "View"));
            break;
        case "GEOMETRY_GL":
            outputs.push(node_output_by_ident(bpy_node, "Global") ||
                         node_output_by_ident(bpy_node, "Position"));
            break;
        case "GEOMETRY_LO":
            outputs.push(node_output_by_ident(bpy_node, "Local"));
            break;
        case "GEOMETRY_OR":
            var or_tra_name = shader_ident("param_GEOMETRY_OR_v");
            vparams.push(node_param(or_tra_name));

            outputs.push(node_output_by_ident(bpy_node, "Orco"));
            params.push(node_param(or_tra_name));
            break;
        case "GEOMETRY_IN":
            outputs.push(node_output_by_ident(bpy_node, "Incoming"));
            break;
        case "GEOMETRY_BF":
            outputs.push(node_output_by_ident(bpy_node, "Backfacing"));
            break;
        }
        break;
    case "TEX_COORD":

        if (!check_input_node_outputs(bpy_node))
            return true;

        type = tex_coord_node_type(bpy_node, output_num);

        switch (type) {
        case "TEX_COORD_UV":
            var uv_layer = bpy_node["uv_layer"];
            if (!uv_layer)
                type = "EMPTY_UV";

            if (type != "EMPTY_UV") {
                var uv_name = shader_ident("param_TEX_COORD_UV_a");
                var uv_tra_name = shader_ident("param_TEX_COORD_UV_v");

                vparams.push(node_param(uv_name));
                vparams.push(node_param(uv_tra_name));

                params.push(node_param(uv_tra_name));

                data = {
                    name: uv_name,
                    value: bpy_node["uv_layer"]
                }
            }
            outputs.push(node_output_by_ident(bpy_node, "UV"));
            break;
        case "TEX_COORD_NO":
            outputs.push(node_output_by_ident(bpy_node, "Normal"));
            break;
        case "TEX_COORD_GE":
            var ge_tra_name = shader_ident("param_TEX_COORD_GE_v");
            vparams.push(node_param(ge_tra_name));

            outputs.push(node_output_by_ident(bpy_node, "Generated"));
            params.push(node_param(ge_tra_name));
            break;
        case "TEX_COORD_OB":
            outputs.push(node_output_by_ident(bpy_node, "Object"));
            break;
        case "TEX_COORD_CA":
            outputs.push(node_output_by_ident(bpy_node, "Camera"));
            break;
        case "TEX_COORD_WI":
            outputs.push(node_output_by_ident(bpy_node, "Window"));
            break;
        case "TEX_COORD_RE":
            outputs.push(node_output_by_ident(bpy_node, "Reflection"));
            break;
        }
        break;
    case "GROUP":
        var node_name = bpy_node["node_tree_name"];
        switch (node_name) {
        case "B4W_LINEAR_TO_SRGB":
            if (!validate_custom_node_group(bpy_node, [1], [1])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            type = "B4W_LINEAR_TO_SRGB";
            break;
        case "B4W_NORMAL_VIEW":
        case "B4W_VECTOR_VIEW":
            if (!validate_custom_node_group(bpy_node, [1], [1])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            type = "B4W_VECTOR_VIEW";
            break;
        case "B4W_SRGB_TO_LINEAR":
            if (!validate_custom_node_group(bpy_node, [1], [1])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            type = "B4W_SRGB_TO_LINEAR";
            break;
        case "B4W_REFLECT":
            if (!validate_custom_node_group(bpy_node, [1,1], [1])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            type = "B4W_REFLECT";
            break;
        case "B4W_REFRACTION":
            if (!validate_custom_node_group(bpy_node, [1,0], [1])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            type = "B4W_REFRACTION";
            break;
        case "B4W_PARALLAX":
            if (!validate_custom_node_group(bpy_node, [1,1,0,0,0], [1])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            var tex_name = shader_ident("param_B4W_PARALLAX_texture");
            params.push(node_param(tex_name));
            type = "B4W_PARALLAX";
            break;
        case "B4W_CLAMP":
            if (!validate_custom_node_group(bpy_node, [1], [1])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            type = "B4W_CLAMP";
            break;
        case "B4W_TRANSLUCENCY":
            if (!validate_custom_node_group(bpy_node, [0,0,0,0,0], [0])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            type = "B4W_TRANSLUCENCY";
            break;
        case "B4W_TIME":
            if (!validate_custom_node_group(bpy_node, [], [0])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            type = "B4W_TIME";
            break;
        case "B4W_SMOOTHSTEP":
            if (!validate_custom_node_group(bpy_node, [0,0,0], [0])) {
                data = process_node_group(bpy_node, mat_name, shader_type);
                break;
            }
            type = "B4W_SMOOTHSTEP";
            break;
        case "B4W_GLOW_OUTPUT":
            type = "B4W_GLOW_OUTPUT";
            break;
        default:
            data = process_node_group(bpy_node, mat_name, shader_type);
        }
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        // NOTE: additional translucency output
        if (node_name == "B4W_TRANSLUCENCY") {
            var out = default_node_inout("TranslucencyParams", "TranslucencyParams", [0,0,0,0]);
            out.is_linked = outputs[0].is_linked;
            outputs.push(out);
        }
        break;
    case "LAMP":
        var bpy_lamp = bpy_node["lamp"];
        if (!bpy_lamp) {
            m_print.error("There is no lamp in node: " + bpy_node["name"]);
            dirs.push(["LAMP_INDEX", -1]);
        } else {
            if (!(bpy_lamp["uuid"] in _lamp_indexes)) {
                _lamp_indexes[bpy_lamp["uuid"]] = _lamp_index;
                dirs.push(["LAMP_INDEX", String(_lamp_index++)]);
            } else
                dirs.push(["LAMP_INDEX", String(_lamp_indexes[bpy_lamp["uuid"]])]);
            data = _lamp_indexes;
        }
        outputs.push(node_output_by_ident(bpy_node, "Color"));
        outputs.push(node_output_by_ident(bpy_node, "Light Vector"));
        outputs.push(node_output_by_ident(bpy_node, "Distance"));
        outputs.push(node_output_by_ident(bpy_node, "Visibility Factor"));
        break;

    case "LIGHTING_AMBIENT":
        inputs = [default_node_inout("E", "E", [0,0,0], true),
                  default_node_inout("A", "A", [0,0,0], true),
                  default_node_inout("D", "D", [0,0,0], true)];
        outputs = [default_node_inout("color", "color", [0,0,0], true),
                   default_node_inout("specular", "specular", [0,0,0], true)]
        break;
    case "LIGHTING_BEGIN":
        outputs = [default_node_inout("E", "E", [0,0,0], true),
                  default_node_inout("A", "A", [0,0,0], true),
                  default_node_inout("D", "D", [0,0,0], true),
                  default_node_inout("S", "S", [0,0,0], true),
                  default_node_inout("normal", "normal", [0,0,0], true),
                  default_node_inout("dif_params", "dif_params", [0,0], true),
                  default_node_inout("sp_params", "sp_params", [0,0], true),
                  default_node_inout("shadow_factor", "shadow_factor", 0, true),
                  default_node_inout("translucency_color", "translucency_color", 0, true),
                  default_node_inout("translucency_params", "translucency_params", [0,0,0,0], true)];
        break;
    case "LIGHTING_END":
        inputs = [default_node_inout("color", "color", [0,0,0], true),
                  default_node_inout("specular", "specular", [0,0,0], true)];
        break;
    case "LIGHTING_LAMP":
        inputs = [default_node_inout("shadow_factor", "shadow_factor", 0, true)];
        outputs = [default_node_inout("ldir", "ldir", [0,0,0], true),
                   default_node_inout("lfac", "lfac", [0,0], true),
                   default_node_inout("lcolorint", "lcolorint", [0,0,0], true),
                   default_node_inout("norm_fac", "norm_fac", 0, true)]
        break;
    case "DIFFUSE_LAMBERT":
        inputs = [default_node_inout("ldir", "ldir", [0,0,0], true),
                  default_node_inout("lfac", "lfac", [0,0], true),
                  default_node_inout("normal", "normal", [0,0,0], true),
                  default_node_inout("norm_fac", "norm_fac", 0, true)];
        outputs = [default_node_inout("lfactor", "lfactor", 0, true)];
        dirs.push(["MAT_USE_TBN_SHADING", bpy_node["use_tangent_shading"] | 0]);
        break;
    case "DIFFUSE_FRESNEL":
    case "DIFFUSE_MINNAERT":
    case "DIFFUSE_OREN_NAYAR":
    case "DIFFUSE_TOON":
        inputs = [default_node_inout("ldir", "ldir", [0,0,0], true),
                  default_node_inout("lfac", "lfac", [0,0], true),
                  default_node_inout("normal", "normal", [0,0,0], true),
                  default_node_inout("norm_fac", "norm_fac", 0, true),
                  default_node_inout("dif_params", "dif_params", [0,0], true)];
        outputs = [default_node_inout("lfactor", "lfactor", 0, true)];
        dirs.push(["MAT_USE_TBN_SHADING", bpy_node["use_tangent_shading"] | 0]);
        break;
    case "SPECULAR_BLINN":
    case "SPECULAR_PHONG":
    case "SPECULAR_COOKTORR":
        inputs = [default_node_inout("ldir", "ldir", [0,0,0], true),
                  default_node_inout("lfac", "lfac", [0,0], true),
                  default_node_inout("normal", "normal", [0,0,0], true),
                  default_node_inout("norm_fac", "norm_fac", 0, true),
                  default_node_inout("sp_params", "sp_params", [0,0], true)];
        outputs = [default_node_inout("sfactor", "sfactor", 0, true)];
        dirs.push(["MAT_USE_TBN_SHADING", bpy_node["use_tangent_shading"] | 0]);
        break;
    case "SPECULAR_TOON":
    case "SPECULAR_WARDISO":
        inputs = [default_node_inout("ldir", "ldir", [0,0,0], true),
                  default_node_inout("lfac", "lfac", [0,0], true),
                  default_node_inout("normal", "normal", [0,0,0], true),
                  default_node_inout("norm_fac", "norm_fac", 0, true),
                  default_node_inout("sp_params", "sp_params", [0,0], true)];
        outputs = [default_node_inout("sfactor", "sfactor", 0, true)];
        dirs.push(["MAT_USE_TBN_SHADING", bpy_node["use_tangent_shading"] | 0]);
        break;
    case "BSDF_COMPUTE":
        inputs = [default_node_inout("ldir", "ldir", [0,0,0], true),
                  default_node_inout("lfac", "lfac", [0,0], true),
                  default_node_inout("normal", "normal", [0,0,0], true),
                  default_node_inout("norm_fac", "norm_fac", 0, true),
                  default_node_inout("bsdf_params", "bsdf_params", [0,0,0,0], true)];
        outputs = [default_node_inout("lfactor", "lfactor", 0, true),
                   default_node_inout("sfactor", "sfactor", 0, true)];
        break;
    case "LIGHTING_APPLY":
        inputs = [default_node_inout("color", "color", [0,0,0,0], true),
                  default_node_inout("specular", "specular", [0,0,0], true),
                  default_node_inout("lfactor", "lfactor", 0, true),
                  default_node_inout("sfactor", "sfactor", 0, true),
                  default_node_inout("ldir", "ldir", [0,0,0], true),
                  default_node_inout("normal", "normal", [0,0,0], true),
                  default_node_inout("translucency_params", "translucency_params", [0,0,0,0], true),
                  default_node_inout("D", "D", [0,0,0], true),
                  default_node_inout("S", "S", [0,0,0], true),
                  default_node_inout("lcolorint", "lcolorint", [0,0,0], true),
                  default_node_inout("translucency_color", "translucency_color", 0, true)];
        outputs = [default_node_inout("color", "color", [0,0,0,0], true),
                   default_node_inout("specular", "specular", [0,0,0], true)];
        break;
    case "NORMAL":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);

        var output_norm = node_output_by_ident(bpy_node, "Normal");
        params.push(node_param(shader_ident("param_NORMAL_Normal"),
                output_norm.default_value, 3));
        break;
    case "MAPPING":
        var vector_type = bpy_node["vector_type"];

        type = "MAPPING";

        inputs.push(node_input_by_ident(bpy_node, "Vector"));
        outputs.push(node_output_by_ident(bpy_node, "Vector"));

        var rot = m_util.f32(bpy_node["rotation"]);
        var scale = m_util.f32(bpy_node["scale"]);
        var trans = m_util.f32(bpy_node["translation"]);
        var trs_matrix = m_mat3.create();

        // rotation
        var rot_matrix = m_util.euler_to_rotation_matrix(rot);

        // HACK: set non-zero scale to allow matrix inverse
        if (vector_type == "TEXTURE") {
            scale[0] = scale[0] || 1.0;
            scale[1] = scale[1] || 1.0;
            scale[2] = scale[2] || 1.0;
        }

        // scale
        var scale_matrix = new Float32Array([scale[0],0,0,0,scale[1],0,0,0,scale[2]]);

        m_mat3.multiply(rot_matrix, scale_matrix, trs_matrix);
        trs_matrix = m_util.mat3_to_mat4(trs_matrix, m_mat4.create());
        switch (vector_type) {
        case "POINT":
            // order of transforms: translation -> rotation -> scale
            // translation
            trs_matrix[12] = trans[0];
            trs_matrix[13] = trans[1];
            trs_matrix[14] = trans[2];
            break;
        case "TEXTURE":
            // order of transforms: translation -> rotation -> scale -> invert
            // translation
            trs_matrix[12] = trans[0];
            trs_matrix[13] = trans[1];
            trs_matrix[14] = trans[2];
            trs_matrix = m_mat4.invert(trs_matrix, trs_matrix);
            break;
        case "NORMAL":
            // order of transforms: rotation -> scale -> invert ->transpose
            m_mat4.invert(trs_matrix, trs_matrix);
            m_mat4.transpose(trs_matrix, trs_matrix);
            break;
        }

        switch (vector_type) {
        case "NORMAL":
            dirs.push(["MAPPING_IS_NORMAL", 1]);
        case "TEXTURE":
            dirs.push(["MAPPING_TRS_MATRIX_DEF", 1]);
            dirs.push(["MAPPING_TRS_MATRIX", m_shaders.glsl_value(trs_matrix, 16)]);
            break;
        case "POINT":
            if (m_vec3.length(rot) !== 0) {
                dirs.push(["MAPPING_TRS_MATRIX_DEF", 1]);
                dirs.push(["MAPPING_TRS_MATRIX", m_shaders.glsl_value(trs_matrix, 16)]);
            } else {
                if (m_vec3.length(scale) !== 0) {
                    dirs.push(["MAPPING_SCALE_DEF", 1]);
                    dirs.push(["MAPPING_SCALE", m_shaders.glsl_value(scale, 3)]);
                }
                if (m_vec3.length(trans) !== 0) {
                    dirs.push(["MAPPING_TRANS_DEF", 1]);
                    dirs.push(["MAPPING_TRANS", m_shaders.glsl_value(trans, 3)]);
                }
            }
            break;
        case "VECTOR":
            if (m_vec3.length(rot) !== 0) {
                dirs.push(["MAPPING_TRS_MATRIX_DEF", 1]);
                dirs.push(["MAPPING_TRS_MATRIX", m_shaders.glsl_value(trs_matrix, 16)]);
            } else if (m_vec3.length(scale) !== 0) {
                dirs.push(["MAPPING_SCALE_DEF", 1]);
                dirs.push(["MAPPING_SCALE", m_shaders.glsl_value(scale, 3)]);
            }
            break;
        }

        // clipping
        if (bpy_node["use_min"]) {
            dirs.push(["MAPPING_MIN_CLIP_DEF", 1]);
            dirs.push(["MAPPING_MIN_CLIP", m_shaders.glsl_value(bpy_node["min"], 3)]);
        }

        if (bpy_node["use_max"]) {
            dirs.push(["MAPPING_MAX_CLIP_DEF", 1]);
            dirs.push(["MAPPING_MAX_CLIP", m_shaders.glsl_value(bpy_node["max"], 3)]);
        }
        break;
    case "MATERIAL":
    case "MATERIAL_EXT":
        var material_begin_dirs = []
        var material_end_dirs = []

        // MATERIAL BEGIN main inputs/outputs
        var material_begin_inputs = [];
        var material_begin_outputs = [default_node_inout("E", "E", [0, 0, 0], true), 
                                      default_node_inout("A", "A", [0, 0, 0], true),
                                      default_node_inout("D", "D", [0, 0, 0], true),
                                      default_node_inout("S", "S", [0, 0, 0], true),
                                      default_node_inout("normal", "normal", [0, 0, 0], true),
                                      default_node_inout("dif_params", "dif_params", [0, 0], true),
                                      default_node_inout("sp_params", "sp_params", [0, 0], true),
                                      default_node_inout("shadow_factor", "shadow_factor", 0, true)];

        // MATERIAL END main inputs/outputs/params
        var material_end_inputs = [default_node_inout("color", "color", [0, 0, 0], true),
                                   default_node_inout("specular", "specular", [0, 0, 0], true),
                                   default_node_inout("normal", "normal", [0, 0, 0], true)];
        var material_end_outputs = [node_output_by_ident(bpy_node, "Color"),
                                    node_output_by_ident(bpy_node, "Alpha"),
                                    node_output_by_ident(bpy_node, "Normal")];

        var material_end_params = [];


        // MATERIAL BEGIN INPUT 0
        var input = node_input_by_ident(bpy_node, "Color");
        input.default_value.splice(3); // vec4 -> vec3
        material_begin_inputs.push(input);
        inputs.push(input);

        // MATERIAL BEGIN INPUT 1
        input = node_input_by_ident(bpy_node, "Spec");
        input.default_value.splice(3); // vec4 -> vec3
        material_begin_inputs.push(input);
        inputs.push(input);

        // MATERIAL BEGIN INPUT 2
        input = node_input_by_ident(bpy_node, "DiffuseIntensity");

        // NOTE: Blender doesn't update the identifier of this node for old files
        if (!input)
            input = node_input_by_ident(bpy_node, "Refl");

        // NOTE: Blender doesn't the default value of this node for old files
        input.default_value = bpy_node["diffuse_intensity"];

        material_begin_inputs.push(input);
        inputs.push(input);

        // MATERIAL BEGIN INPUT 3
        var input_norm = node_input_by_ident(bpy_node, "Normal");
        input_norm.default_value.splice(3); // vec4 -> vec3
        material_begin_inputs.push(input_norm);
        inputs.push(input_norm);

        if (type == "MATERIAL_EXT") {
            // additional inputs/outputs for extended materials

            // MATERIAL BEGIN INPUT 4
            input = node_input_by_ident(bpy_node, "Emit");
            if (!input)
                input = default_node_inout("Emit", "Emit", 0);
            material_begin_inputs.push(input);
            inputs.push(input);

            // NOTE: additional inputs from translucency node
            input = node_input_by_ident(bpy_node, "Translucency");
            if (input) {
                input.default_value = 0;
                input.name = "Translucency";
                input.identifier = "Translucency";
            } else
                input = default_node_inout("Translucency", "Translucency", 0);
            inputs.push(input);

            input = node_input_by_ident(bpy_node, "Translucency");
            if (input) {
                input.default_value = [0, 0, 0, 0];
                input.name = "TranslucencyParams";
                input.identifier = "TranslucencyParams";
            } else
                input = default_node_inout("TranslucencyParams", "TranslucencyParams", [0, 0, 0, 0]);
            inputs.push(input);

            // MATERIAL END INPUT 4

            // NOTE: Blender version >= 2.74: Reflectivity
            // Blender version < 2.74: Ray Mirror
            var input_new = node_input_by_ident(bpy_node, "Reflectivity");
            var input_old = node_input_by_ident(bpy_node, "Ray Mirror");

            if (input_new) {
                input = input_new;
                var input_name = "Reflectivity";
            } else if (input_old) {
                input = input_old;
                var input_name = "Ray Mirror";
            } else {
                input = input_new;
                var input_name = "Reflectivity";
            }

            if (!input)
                input = default_node_inout(input_name, input_name, 0);
            inputs.push(input);
            material_end_inputs.push(input);

            // MATERIAL END INPUT 5
            input = node_input_by_ident(bpy_node, "SpecTra");
            if (!input)
                input = default_node_inout("SpecTra", "SpecTra", 0);
            inputs.push(input);
            material_end_inputs.push(input);

            // MATERIAL END INPUT 6
            input = node_input_by_ident(bpy_node, "Alpha");
            if (!input)
                input = default_node_inout("Alpha", "Alpha", bpy_node["alpha"]);
            inputs.push(input);
            material_end_inputs.push(input);

            material_end_outputs.push(node_output_by_ident(bpy_node, "Diffuse"));
            material_end_outputs.push(node_output_by_ident(bpy_node, "Spec"));

            material_begin_dirs.push(["MATERIAL_EXT", 1]);
            material_end_dirs.push(["MATERIAL_EXT", 1]);
        } else {
            material_begin_inputs.push(default_node_inout("emit_intensity", "emit_intensity", 0));
            
            material_end_inputs.push(default_node_inout("reflect_factor", "reflect_factor", 0));
            material_end_inputs.push(default_node_inout("specular_alpha", "specular_alpha", 0));
            material_end_inputs.push(default_node_inout("alpha_in", "alpha_in", 0));

            material_end_outputs.push(default_node_inout("diffuse_out", "diffuse_out", 0));
            material_end_outputs.push(default_node_inout("spec_out", "spec_out", 0));
            material_begin_dirs.push(["MATERIAL_EXT", 0]);
            material_end_dirs.push(["MATERIAL_EXT", 0]);
        }
        
        material_end_params.push(node_param(shader_ident("param_MATERIAL_alpha"),
                               bpy_node["alpha"]));
        material_end_params.push(node_param(shader_ident("param_MATERIAL_spec_alpha"),
                               bpy_node["specular_alpha"]));
        
        // MATERIAL outputs
        outputs = material_end_outputs;

        // MATERIAL dirs
        material_begin_dirs.push(["USE_MATERIAL_NORMAL", input_norm.is_linked | 0]);

        if (bpy_node["use_diffuse"]) {
            material_begin_dirs.push(["USE_MATERIAL_DIFFUSE", 1]);
            material_end_dirs.push(["USE_MATERIAL_DIFFUSE", 1]);
        }

        if (bpy_node["use_specular"])
            material_end_dirs.push(["USE_MATERIAL_SPECULAR", 1]);

        // MATERIAL BEGIN params
        var material_begin_params = []
        var spec_param_0;
        var spec_param_1 = 0;
        switch (bpy_node["specular_shader"]) {
        case "COOKTORR":
        case "PHONG":
            spec_param_0 = bpy_node["specular_hardness"];
            break;
        case "WARDISO":
            spec_param_0 = bpy_node["specular_slope"];
            break;
        case "TOON":
            spec_param_0 = bpy_node["specular_toon_size"];
            spec_param_1 = bpy_node["specular_toon_smooth"];
            break;
        case "BLINN":
            spec_param_0 = bpy_node["specular_ior"];
            spec_param_1 = bpy_node["specular_hardness"];
            break;
        default:
            m_print.error("unsupported specular shader: " +
                bpy_node["specular_shader"] + " (material \"" +
                bpy_node["material_name"] + "\")");
            spec_param_0 = bpy_node["specular_hardness"];
            break;
        }

        var diffuse_param;
        var diffuse_param2;
        switch (bpy_node["diffuse_shader"]) {
        case "LAMBERT":
            diffuse_param = 0.0;
            diffuse_param2 = 0.0;
            break;
        case "OREN_NAYAR":
            diffuse_param = bpy_node["roughness"];
            diffuse_param2 = 0.0;
            break;
        case "FRESNEL":
            diffuse_param = bpy_node["diffuse_fresnel"];
            diffuse_param2 = bpy_node["diffuse_fresnel_factor"];
            break;
        case "MINNAERT":
            diffuse_param = bpy_node["darkness"];
            diffuse_param2 = 0.0;
            break;
        case "TOON":
            diffuse_param = bpy_node["diffuse_toon_size"];
            diffuse_param2 = bpy_node["diffuse_toon_smooth"];
            break;
        default:
            m_print.error("unsupported diffuse shader: " +
                bpy_node["diffuse_shader"] + " (material \"" +
                bpy_node["material_name"] + "\")");
            diffuse_param = 0.0;
            diffuse_param2 = 0.0;
            break;
        }

        material_begin_params.push(node_param(shader_ident("param_MATERIAL_diffuse"),
                                [diffuse_param, diffuse_param2], 2));

        material_begin_params.push(node_param(shader_ident("param_MATERIAL_spec"),
                               [bpy_node["specular_intensity"],
                                spec_param_0, spec_param_1], 3));

        material_begin_dirs.push(["SHADELESS_MAT", bpy_node["use_shadeless"]? 1: 0]);

        var path_data = {
            name: bpy_node["name"],
            value: {
                specular_shader: bpy_node["specular_shader"],
                diffuse_shader: bpy_node["diffuse_shader"],
                use_shadeless: bpy_node["use_shadeless"],
                use_tangent_shading: bpy_node["use_tangent_shading"]
            },
        }

        // MATERIAL BEGIN
        var material_begin = {
            "name": "material_begin",
            "type": "MATERIAL_BEGIN",
            inputs: material_begin_inputs,
            outputs: material_begin_outputs,
            params: material_begin_params,
            data: path_data,
            dirs: material_begin_dirs,
            vparams: []
        }

        // MATERIAL END        
        var material_end = {
            "name": "material_end",
            "type": "MATERIAL_END",
            inputs: material_end_inputs,
            outputs: material_end_outputs,
            params: material_end_params,
            data: path_data,
            dirs: material_end_dirs,
            vparams: []
        }

        // MATERIAL data
        data = {
            name: bpy_node["name"],
            value: {
                specular_shader: bpy_node["specular_shader"],
                diffuse_shader: bpy_node["diffuse_shader"],
                use_shadeless: bpy_node["use_shadeless"],
                use_tangent_shading: bpy_node["use_tangent_shading"]
            },
            material_begin: material_begin,
            material_end: material_end
        }

        break;
    case "BSDF_DIFFUSE":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        dirs.push(["USE_NORMAL_IN", inputs[2].is_linked | 0]);
        var bsdf_output = node_output_by_ident(bpy_node, "BSDF");
        var bsdf_output_is_linked = bsdf_output.is_linked;
        outputs = [bsdf_output,
                   default_node_inout("d_color", "d_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("d_roughness", "d_roughness", 0, bsdf_output_is_linked),
                   default_node_inout("s_color", "s_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("s_roughness", "s_roughness", 0, bsdf_output_is_linked),
                   default_node_inout("metalness", "metalness", 0, bsdf_output_is_linked),
                   default_node_inout("normal", "normal", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("e_color", "e_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("emisson", "emisson", 0, bsdf_output_is_linked),
                   default_node_inout("a_color", "a_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("alpha", "alpha", 1, bsdf_output_is_linked)];
        break;
    case "BSDF_GLOSSY":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        dirs.push(["USE_NORMAL_IN", inputs[2].is_linked | 0]);
        var bsdf_output = node_output_by_ident(bpy_node, "BSDF");
        var bsdf_output_is_linked = bsdf_output.is_linked;
        outputs = [bsdf_output,
                   default_node_inout("d_color", "d_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("d_roughness", "d_roughness", 0, bsdf_output_is_linked),
                   default_node_inout("s_color", "s_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("s_roughness", "s_roughness", 0, bsdf_output_is_linked),
                   default_node_inout("metalness", "metalness", 1, bsdf_output_is_linked),
                   default_node_inout("normal", "normal", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("e_color", "e_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("emisson", "emisson", 0, bsdf_output_is_linked), 
                   default_node_inout("a_color", "a_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("alpha", "alpha", 1, bsdf_output_is_linked)];
        break;
    case "BSDF_TRANSPARENT":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        var bsdf_output = node_output_by_ident(bpy_node, "BSDF");
        var bsdf_output_is_linked = bsdf_output.is_linked;
        outputs = [bsdf_output,
                   default_node_inout("d_color", "d_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("d_roughness", "d_roughness", 0, bsdf_output_is_linked),
                   default_node_inout("s_color", "s_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("s_roughness", "s_roughness", 0, bsdf_output_is_linked),
                   default_node_inout("metalness", "metalness", 0, bsdf_output_is_linked),
                   default_node_inout("normal", "normal", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("e_color", "e_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("emisson", "emisson", 0, bsdf_output_is_linked),
                   default_node_inout("a_color", "a_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("alpha", "alpha", 1, bsdf_output_is_linked)];
        break;
    case "EMISSION":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        var emission_output = node_output_by_ident(bpy_node, "Emission");
        var emission_output_is_linked = emission_output.is_linked;
        outputs = [emission_output,
                   default_node_inout("d_color", "d_color", [0, 0, 0], emission_output_is_linked),
                   default_node_inout("d_roughness", "d_roughness", 0, emission_output_is_linked),
                   default_node_inout("s_color", "s_color", [0, 0, 0], emission_output_is_linked),
                   default_node_inout("s_roughness", "s_roughness", 0, emission_output_is_linked),
                   default_node_inout("metalness", "metalness", 1, emission_output_is_linked),
                   default_node_inout("normal", "normal", [0, 0, 0], emission_output_is_linked),
                   default_node_inout("e_color", "e_color", [0, 0, 0], emission_output_is_linked),
                   default_node_inout("emisson", "emisson", 1, emission_output_is_linked),
                   default_node_inout("a_color", "a_color", [0, 0, 0], bsdf_output_is_linked),
                   default_node_inout("alpha", "alpha", 1, bsdf_output_is_linked)];
        break;
    case "MATH":
        switch (bpy_node["operation"]) {
        case "ADD":
            type = "MATH_ADD";
            break;
        case "SUBTRACT":
            type = "MATH_SUBTRACT";
            break;
        case "MULTIPLY":
            type = "MATH_MULTIPLY";
            break;
        case "DIVIDE":
            type = "MATH_DIVIDE";
            break;
        case "SINE":
            type = "MATH_SINE";
            break;
        case "COSINE":
            type = "MATH_COSINE";
            break;
        case "TANGENT":
            type = "MATH_TANGENT";
            break;
        case "ARCSINE":
            type = "MATH_ARCSINE";
            break;
        case "ARCCOSINE":
            type = "MATH_ARCCOSINE";
            break;
        case "ARCTANGENT":
            type = "MATH_ARCTANGENT";
            break;
        case "POWER":
            type = "MATH_POWER";
            break;
        case "LOGARITHM":
            type = "MATH_LOGARITHM";
            break;
        case "MINIMUM":
            type = "MATH_MINIMUM";
            break;
        case "MAXIMUM":
            type = "MATH_MAXIMUM";
            break;
        case "ROUND":
            type = "MATH_ROUND";
            break;
        case "LESS_THAN":
            type = "MATH_LESS_THAN";
            break;
        case "GREATER_THAN":
            type = "MATH_GREATER_THAN";
            break;
        case "MODULO":
            type = "MATH_MODULO";
            break;
        case "ABSOLUTE":
            type = "MATH_ABSOLUTE";
            break;
        default:
            m_print.error("Unsupported MATH operation: " +
                    bpy_node["operation"]);
            return null;
        }
        dirs.push(["MATH_USE_CLAMP", Number(bpy_node["use_clamp"])]);
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        break;
    case "MIX_RGB":
        switch (bpy_node["blend_type"]) {
        case "MIX":
            type = "MIX_RGB_MIX";
            break;
        case "ADD":
            type = "MIX_RGB_ADD";
            break;
        case "MULTIPLY":
            type = "MIX_RGB_MULTIPLY";
            break;
        case "SUBTRACT":
            type = "MIX_RGB_SUBTRACT";
            break;
        case "SCREEN":
            type = "MIX_RGB_SCREEN";
            break;
        case "DIVIDE":
            type = "MIX_RGB_DIVIDE";
            break;
        case "DIFFERENCE":
            type = "MIX_RGB_DIFFERENCE";
            break;
        case "DARKEN":
            type = "MIX_RGB_DARKEN";
            break;
        case "LIGHTEN":
            type = "MIX_RGB_LIGHTEN";
            break;
        case "OVERLAY":
            type = "MIX_RGB_OVERLAY";
            break;
        case "DODGE":
            type = "MIX_RGB_DODGE";
            break;
        case "BURN":
            type = "MIX_RGB_BURN";
            break;
        case "HUE":
            type = "MIX_RGB_HUE";
            break;
        case "SATURATION":
            type = "MIX_RGB_SATURATION";
            break;
        case "VALUE":
            type = "MIX_RGB_VALUE";
            break;
        case "COLOR":
            type = "MIX_RGB_COLOR";
            break;
        case "SOFT_LIGHT":
            type = "MIX_RGB_SOFT_LIGHT";
            break;
        case "LINEAR_LIGHT":
            type = "MIX_RGB_LINEAR_LIGHT";
            break;
        default:
            m_print.error("Unsupported MIX_RGB blend type: " +
                    bpy_node["blend_type"]);
            return null;
        }
        dirs.push(["MIX_RGB_USE_CLAMP", Number(bpy_node["use_clamp"])]);
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);

        break;
    case "MIX_WORLD_RGB":
    case "ADD_WORLD_RGB":
        inputs = [default_node_inout("Factor", "Factor", bpy_node["fac"], bpy_node["fac_is_linked"]),
                  default_node_inout("Color1", "Color1", [0,0,0], bpy_node["color1_is_linked"]),
                  default_node_inout("Color2", "Color1", [0,0,0], bpy_node["color2_is_linked"])];
        outputs = [default_node_inout("Color", "Color", [0,0,0], true)];
        break;
    case "OUTPUT":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = [];
        break;
    case "OUTPUT_MATERIAL":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = [];

        var surface_input = node_input_by_ident(bpy_node, "Surface");
        var surface_inp_is_linked = surface_input.is_linked;

        var bsdf_begin_dirs = [];
        var bsdf_end_dirs = [];
        // BSDF BEGIN main inputs/outputs
        var bsdf_begin_inputs = [surface_input,
                                 default_node_inout("d_color", "d_color", [0, 0, 0], surface_inp_is_linked),
                                 default_node_inout("d_roughness", "d_roughness", 0, surface_inp_is_linked),
                                 default_node_inout("s_color", "s_color", [0, 0, 0], surface_inp_is_linked),
                                 default_node_inout("s_roughness", "s_roughness", 0, surface_inp_is_linked),
                                 default_node_inout("metalness", "metalness", 0, surface_inp_is_linked),
                                 default_node_inout("normal", "normal", [0, 0, 0], surface_inp_is_linked),
                                 default_node_inout("e_color", "e_color", [0, 0, 0], surface_inp_is_linked),
                                 default_node_inout("emission", "emission", 0, surface_inp_is_linked),
                                 default_node_inout("a_color", "a_color", [0, 0, 0], surface_inp_is_linked),
                                 default_node_inout("alpha", "alpha", 0, surface_inp_is_linked)];

        var bsdf_begin_outputs = [default_node_inout("E", "E", [0, 0, 0], true),
                                  default_node_inout("A", "A", [0, 0, 0], true),
                                  default_node_inout("D", "D", [0, 0, 0], true),
                                  default_node_inout("S", "S", [0, 0, 0], true),
                                  default_node_inout("normal", "normal", [0, 0, 0], true),
                                  default_node_inout("bsdf_params", "bsdf_params", [0, 0, 0, 0], true),
                                  default_node_inout("shadow_factor", "shadow_factor", 0, true),
                                  default_node_inout("d_color", "d_color", [0, 0, 0], true),
                                  default_node_inout("s_color", "s_color", [0, 0, 0], true),
                                  default_node_inout("e_color", "e_color", [0, 0, 0], true),
                                  default_node_inout("emission", "emission", 0, true),
                                  default_node_inout("a_color", "a_color", [0, 0, 0], true),
                                  default_node_inout("alpha", "alpha", 0, true)];

        // BSDF END main inputs/outputs/params
        var bsdf_end_inputs = [default_node_inout("color", "color", [0, 0, 0], true),
                               default_node_inout("specular", "specular", [0, 0, 0], true),
                               default_node_inout("normal", "normal", [0, 0, 0], true),
                               default_node_inout("bsdf_params", "bsdf_params", [0, 0, 0, 0], true),
                               default_node_inout("d_color", "d_color", [0, 0, 0], true),
                               default_node_inout("s_color", "s_color", [0, 0, 0], true),
                               default_node_inout("e_color", "e_color", [0, 0, 0], true),
                               default_node_inout("emission", "emission", 0, true),
                               default_node_inout("a_color", "a_color", [0, 0, 0], true),
                               default_node_inout("alpha", "alpha", 0, true)];
        var bsdf_end_outputs = [default_node_inout("color", "color", [0, 0, 0], surface_inp_is_linked)];
        var bsdf_begin_params = [];
        var bsdf_end_params = [];

        // BSDF BEGIN
        var bsdf_begin = {
            "name": "bsdf_begin",
            "type": "BSDF_BEGIN",
            inputs: bsdf_begin_inputs,
            outputs: bsdf_begin_outputs,
            params: bsdf_begin_params,
            data: null,
            dirs: bsdf_begin_dirs,
            vparams: []
        };

        // BSDF END
        var bsdf_end = {
            "name": "bsdf_end",
            "type": "BSDF_END",
            inputs: bsdf_end_inputs,
            outputs: bsdf_end_outputs,
            params: bsdf_end_params,
            data: null,
            dirs: bsdf_end_dirs,
            vparams: []
        };


        // OUTPUT_SURFACE main inputs/outputs/params
        var output_surface_inputs = [surface_input];
        var output_surface_outputs = []
        var output_surface_params = [];
        var output_surface_dirs = []

        // OUTPUT_SURFACE
        var output_surface = {
            "name": "output_surface",
            "type": "OUTPUT_SURFACE",
            inputs: output_surface_inputs,
            outputs: output_surface_outputs,
            params: output_surface_params,
            data: {
                value: {
                    bsdf_shader: "BSDF_COMPUTE"
                },
                bsdf_begin: bsdf_begin,
                bsdf_end: bsdf_end
            },
            dirs: output_surface_dirs,
            vparams: []
        };


        // DISPLACEMENT_BUMP main inputs/outputs/params
        var displacement_bump_inputs = [default_node_inout("Height", "Height", 0, true)];
        var displacement_bump_outputs = [default_node_inout("Normal", "Normal", [0, 0, 0], false)];
        var displacement_bump_params = [];
        var displacement_bump_dirs = []

        // DISPLACEMENT_BUMP
        var displacement_bump = {
            "name": "displacement_bump",
            "type": "DISPLACEMENT_BUMP",
            inputs: displacement_bump_inputs,
            outputs: displacement_bump_outputs,
            params: displacement_bump_params,
            data: null,
            dirs: displacement_bump_dirs,
            vparams: []
        };

        // BSDF data
        data = {
            name: bpy_node["name"],
            output_surface: output_surface,
            displacement_bump: displacement_bump
        };
        break;
    case "OUTPUT_WORLD":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);

        var surface_input = node_input_by_ident(bpy_node, "Surface");

        // OUTPUT_WORLD_SURFACE main inputs/outputs/params
        var output_world_surface_inputs = [surface_input];
        var output_world_surface_outputs = []
        var output_world_surface_params = [];
        var output_world_surface_dirs = []

        // OUTPUT_WORLD_SURFACE
        var output_surface = {
            "name": "output_world_surface",
            "type": "OUTPUT_WORLD_SURFACE",
            inputs: output_world_surface_inputs,
            outputs: output_world_surface_outputs,
            params: output_world_surface_params,
            data: null,
            dirs: output_world_surface_dirs,
            vparams: []
        };

        data = {
            name: bpy_node["name"],
            output_world_surface: output_surface,
        };
        break;
    case "RGB":
        var param_name = bpy_node["name"];
        var param = {
            name: "-1",
            value: param_name
        }
        params.push(param);

        outputs.push(node_output_by_ident(bpy_node, "Color"));

        break;
    case "SEPRGB":
    case "SEPHSV":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        break;
    case "TEX_ENVIRONMENT":
        var image = bpy_node["image"];
        if (!image)
            type = "TEXTURE_EMPTY";
        else {
            type = "TEXTURE_ENVIRONMENT_" + bpy_node["projection"];

            if (bpy_node["color_space"] == "NONE")
                dirs.push(["NON_COLOR", 1]);
            else
                dirs.push(["NON_COLOR", 0]);

            inputs.push(node_input_by_ident(bpy_node, "Vector"));
            dirs.push(["USE_VECTOR_IN", inputs[0].is_linked | 0]);
            outputs.push(node_output_by_ident(bpy_node, "Color"));

            var tex_name = shader_ident("param_TEXTURE_texture");
            params.push(node_param(tex_name));

            var tex = m_tex.create_texture(m_tex.TT_RGBA_INT, false);
            tex.repeat = true;
            tex.source = "IMAGE";
            if (cfg_def.anisotropic_available)
                tex.anisotropic_filtering = 16;

            m_tex.append_img_info(tex, image);

            data = {
                bpy_name: bpy_node["name"],
                bpy_uuid: "", // cycles textures do not have uuid
                name: tex_name,
                value: tex
            };
        }
        break;
    case "TEX_IMAGE":
        var image = bpy_node["image"];
        if (!image)
            type = "TEXTURE_EMPTY";
        else {
            type = "TEXTURE_COLOR";

            if (bpy_node["color_space"] == "NONE")
                dirs.push(["NON_COLOR", 1]);
            else
                dirs.push(["NON_COLOR", 0]);

            dirs.push(["CONVERT_UV", 0]);

            for (var i = 0; i < 4; ++i) {
                var input, output1, output2;

                if (i) {
                    input = default_node_inout("Vector" + i, "Vector" + i, [0,0,0], false);
                    output1 = default_node_inout("Color" + i, "Color" + i, [0,0,0], false);
                    output2 = default_node_inout("Alpha" + i, "Alpha" + i, 0, false);
                } else {
                    input = node_input_by_ident(bpy_node, "Vector");
                    output1 = node_output_by_ident(bpy_node, "Color");
                    output2 = node_output_by_ident(bpy_node, "Alpha");
                }

                inputs.push(input);
                outputs.push(output1);
                outputs.push(output2);
            }

            var tex_name = shader_ident("param_TEXTURE_texture");
            params.push(node_param(tex_name));

            var tex = m_tex.create_texture(m_tex.TT_RGBA_INT, false);
            tex.repeat = bpy_node["extension"] == "REPEAT";
            tex.source = "IMAGE";
            m_tex.append_img_info(tex, image);

            data = {
                bpy_name: bpy_node["name"],
                bpy_uuid: "", // cycles textures do not have uuid
                name: tex_name,
                value: tex
            }
        }
        break
    case "TEXTURE":

        type = texture_node_type(bpy_node);

        if (type == "TEXTURE_EMPTY") {
            outputs.push(node_output_by_ident(bpy_node, "Color"));
            outputs.push(node_output_by_ident(bpy_node, "Normal"));
            outputs.push(node_output_by_ident(bpy_node, "Value"));
        } else if (type == "TEXTURE_ENVIRONMENT_CUBE") {
            inputs.push(node_input_by_ident(bpy_node, "Vector"));
            outputs.push(node_output_by_ident(bpy_node, "Color"));
            outputs.push(node_output_by_ident(bpy_node, "Value"));
        } else {
            if (type == "TEXTURE_NORMAL") {
                if (bpy_node["texture"]["type"] == "ENVIRONMENT_MAP") {
                    m_print.error("Wrong output for ENVIRONMENT_MAP texture: " + bpy_node["name"]);
                    return null;
                }
            }
            if (type == "TEXTURE_COLOR") {
                var non_color = false;
                var bpy_image = bpy_node["texture"]["image"];
                if (bpy_image && (bpy_image["colorspace_settings_name"] == "Non-Color"
                      || bpy_image["colorspace_settings_name"] == "Non-Colour Data"))
                    non_color = true;
                dirs.push(["NON_COLOR", Number(non_color)]);
                dirs.push(["CONVERT_UV", 1]);
            }

            for (var i = 0; i < 4; ++i) {
                var input, output1, output2;

                var out1_name = type == "TEXTURE_COLOR"? "Color": "Normal";

                if (i) {
                    input = default_node_inout("Vector" + i, "Vector" + i, [0,0,0], false);
                    output1 = default_node_inout(out1_name + i, out1_name + i, [0,0,0], false);
                    output2 = default_node_inout("Value" + i, "Value" + i, 0, false);
                } else {
                    input = node_input_by_ident(bpy_node, "Vector");
                    output1 = node_output_by_ident(bpy_node, out1_name);
                    output2 = node_output_by_ident(bpy_node, "Value");
                }

                inputs.push(input);
                outputs.push(output1);
                outputs.push(output2);
            }
        }
        if (type != "TEXTURE_EMPTY") {
            var tex_name = shader_ident("param_TEXTURE_texture");
            params.push(node_param(tex_name));

            var tex = bpy_node["texture"]._render;
            data = {
                bpy_name: bpy_node["texture"]["name"],
                bpy_uuid: bpy_node["texture"]["uuid"],
                name: tex_name,
                value: tex
            }
        }

        break;
    case "VALTORGB":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        data = {
            value: bpy_node
        };
        var interpolation = bpy_node["color_ramp"]["interpolation"];
        if (interpolation != "CONSTANT" && interpolation != "LINEAR")
            m_print.warn("Color Ramp node is not fully supported.");
        break;
    case "VALUE":

        type = "VALUE";

        var param_name = bpy_node["name"];
        var param = {
            name: "-1",
            value: param_name
        }
        params.push(param);

        outputs.push(node_output_by_ident(bpy_node, "Value"));

        break;
    case "VECT_MATH":
        switch (bpy_node["operation"]) {
        case "ADD":
            type = "VECT_MATH_ADD";
            break;
        case "SUBTRACT":
            type = "VECT_MATH_SUBTRACT";
            break;
        case "AVERAGE":
            type = "VECT_MATH_AVERAGE";
            break;
        case "DOT_PRODUCT":
            type = "VECT_MATH_DOT_PRODUCT";
            break;
        case "CROSS_PRODUCT":
            type = "VECT_MATH_CROSS_PRODUCT";
            break;
        case "NORMALIZE":
            type = "VECT_MATH_NORMALIZE";
            break;
        default:
            m_print.error("Unsupported VECT_MATH operation: " +
                    bpy_node["operation"]);
            return null;
        }
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);

        break;
    case "VECT_TRANSFORM":
        switch (bpy_node["vector_type"]) {
        case "POINT":
            dirs.push(["VECTOR_TYPE", m_shaders.glsl_value(VT_POINT)]);
            break;
        case "VECTOR":
            dirs.push(["VECTOR_TYPE", m_shaders.glsl_value(VT_VECTOR)]);
            break;
        case "NORMAL":
            dirs.push(["VECTOR_TYPE", m_shaders.glsl_value(VT_NORMAL)]);
            break;
        default:
            m_print.error("Unsupported VECT_TRANSFORM vector_type: " +
                    bpy_node["vector_type"]);
            return null;
        }
        var convert_from = bpy_node["convert_from"];
        var convert_to = bpy_node["convert_to"];

        var conv_type = VT_WORLD_TO_WORLD;
        if (convert_from == "WORLD") {
            if (convert_to == "WORLD")
                conv_type = VT_WORLD_TO_WORLD;
            else if (convert_to == "OBJECT")
                conv_type = VT_WORLD_TO_OBJECT;
            else if (convert_to == "CAMERA")
                conv_type = VT_WORLD_TO_CAMERA;
            else {
                m_print.error("Unsupported VECT_TRANSFORM convert_to: " +
                     bpy_node["convert_to"]);
                return null;
            }
        } else if (convert_from == "OBJECT") {
            if (convert_to == "WORLD")
                conv_type = VT_OBJECT_TO_WORLD;
            else if (convert_to == "OBJECT")
                conv_type = VT_OBJECT_TO_OBJECT;
            else if (convert_to == "CAMERA")
                conv_type = VT_OBJECT_TO_CAMERA;
            else {
                m_print.error("Unsupported VECT_TRANSFORM convert_to: " +
                        bpy_node["convert_to"]);
                return null;
            }
        } else if (convert_from == "CAMERA") {
            if (convert_to == "WORLD")
                conv_type = VT_CAMERA_TO_WORLD;
            else if (convert_to == "OBJECT")
                conv_type = VT_CAMERA_TO_OBJECT;
            else if (convert_to == "CAMERA")
                conv_type = VT_CAMERA_TO_CAMERA;
            else {
                m_print.error("Unsupported VECT_TRANSFORM convert_to: " +
                        bpy_node["convert_to"]);
                return null;
            }
        } else {
            m_print.error("Unsupported VECT_TRANSFORM convert_from: " +
                    bpy_node["convert_from"]);
            return null;
        }

        dirs.push(["CONVERT_TYPE", m_shaders.glsl_value(conv_type)]);

        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);

        break;
    case "NORMAL_MAP":
        var space = NM_TANGENT;
        switch (bpy_node["space"]) {
        case "TANGENT":
            space = NM_TANGENT;
            break;
        case "OBJECT":
            space = NM_OBJECT;
            break;
        case "WORLD":
            space = NM_WORLD;
            break;
        case "BLENDER_OBJECT":
            space = NM_BLENDER_OBJECT;
            break;
        case "BLENDER_WORLD":
            space = NM_BLENDER_WORLD;
            break;
        default:
            m_print.error("Unsupported NORMAL_MAP space: " +
                    bpy_node["space"]);
            return null;
        }
        dirs.push(["SPACE", m_shaders.glsl_value(space)]);

        inputs.push(node_input_by_ident(bpy_node, "Strength"));
        inputs.push(node_input_by_ident(bpy_node, "Color"));
        // fake input, used only with displacement_bump
        inputs.push(default_node_inout("Normal", "Normal", [0, 0, 0], false));
        dirs.push(["USE_NORMAL_IN", 0]);
        outputs.push(node_output_by_ident(bpy_node, "Normal"));

        break;
    case "FRESNEL":
        var input_norm = node_input_by_ident(bpy_node, "Normal");

        inputs.push(node_input_by_ident(bpy_node, "IOR"));
        inputs.push(input_norm);
        outputs.push(node_output_by_ident(bpy_node, "Fac"));

        dirs.push(["USE_FRESNEL_NORMAL", input_norm.is_linked | 0]);
        break;
    case "LAYER_WEIGHT":
        var input_norm = node_input_by_ident(bpy_node, "Normal");

        inputs.push(node_input_by_ident(bpy_node, "Blend"));
        inputs.push(input_norm);
        outputs = node_outputs_bpy_to_b4w(bpy_node);

        dirs.push(["USE_NORMAL_IN", input_norm.is_linked | 0]);
        break;
    case "BUMP":
        var input_norm = node_input_by_ident(bpy_node, "Normal");
        dirs.push(["INVERT", bpy_node["invert"]? 1: 0]);
        dirs.push(["USE_NORMAL_IN", input_norm.is_linked | 0]);

        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        break;
    case "BACKGROUND":
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);
        break;
    default:
        inputs = node_inputs_bpy_to_b4w(bpy_node);
        outputs = node_outputs_bpy_to_b4w(bpy_node);

        break;
    }

    var attr = {
        name: name,
        origin_name: origin_name,
        type: type,

        vparams: vparams,

        inputs: inputs,
        outputs: outputs,
        params: params,

        data: data,

        dirs: dirs
    }

    var new_node_id = m_graph.gen_node_id(graph);
    m_graph.append_node(graph, new_node_id, attr);

    // recursively split GEOMETRY or TEX_COORD node
    if ((bpy_node["type"] == "GEOMETRY" || bpy_node["type"] == "TEX_COORD" ||
         bpy_node["type"] == "NEW_GEOMETRY") &&
            node_output_check_next(bpy_node, output_num))
        if (append_nmat_node(graph, bpy_node, ++output_num, mat_name, 
                shader_type) == null)
            return null;

    return new_node_id;
}

function validate_custom_node_group(bpy_node, inputs_map, outputs_map) {

    var bpy_inputs = bpy_node["inputs"];
    var bpy_outputs = bpy_node["outputs"];
    var node_name = bpy_node["node_tree_name"];

    for (var i = 0; i < inputs_map.length; i++) {
        var input = bpy_inputs[i];
        var need_vec_in = inputs_map[i];
        if (!input || input["default_value"] instanceof Array != need_vec_in) {
            m_print.warn("Wrong inputs for custom node group \"" +
                bpy_node["name"] + "\" of type: \"", node_name, "\"." +
                "Processing as general node group.");
            return false;
        }
    }
    for (var i = 0; i < outputs_map.length; i++) {
        var output = bpy_outputs[i];
        var need_vec_out = outputs_map[i];
        if (!output || output["default_value"] instanceof Array != need_vec_out) {
            m_print.warn("Wrong outputs for custom node group \"" +
                bpy_node["name"] + "\" of type: \"", node_name, "\"." +
                "Processing as general node group.");
            return false;
        }
    }

    return true;
}

function process_node_group(bpy_node, mat_name, shader_type) {
    // NOTE: Node tree is cloned here for a node group to prevent modifying the 
    // source node tree. Modifying is needed to store some information about the 
    // node group because we don't create a graph for it and just gather the 
    // corresponding data.
    var node_tree = clone_node_tree(bpy_node["node_group"]["node_tree"]);

    var node_name = bpy_node["node_tree_name"];

    if (node_name == "B4W_REPLACE" || node_name == "B4W_LEVELS_OF_QUALITY") {
        var gi = init_bpy_node("Group input", "GROUP_INPUT", [], bpy_node["inputs"]);
        var go = init_bpy_node("Group output", "GROUP_OUTPUT", bpy_node["outputs"], []);

        var link = null;
        if (node_name == "B4W_REPLACE" ||
            node_name == "B4W_LEVELS_OF_QUALITY" &&
            (cfg_def.quality == m_cfg.P_LOW || cfg_def.force_low_quality_nodes)) {
            link = init_bpy_link(gi, gi["outputs"][1], go, go["inputs"][0]);
        } else
            link = init_bpy_link(gi, gi["outputs"][0], go, go["inputs"][0]);

        node_tree["nodes"] = [gi, go];
        node_tree["links"] = [link];
    }

    rename_node_group_nodes(bpy_node["name"], node_tree);
    var ngraph_proxy_group = compose_ngraph_proxy(node_tree,
            bpy_node["node_group"]["uuid"], true, mat_name, shader_type);
    var data = {
        node_group_graph: ngraph_proxy_group.graph,
        node_group_links: node_tree["links"]
    };
    return data;
}

function reset_shader_ident_counters() {
    _shader_ident_counters = {};
}

function copy_obj(obj) {
    var type = typeof(obj);
    if (type == "string" || type == "number" || type == "boolean" || !obj)
        return obj;
    return m_util.clone_object_nr(obj);
}

function clone_node_tree(tree) {
    var new_tree = {};

    for (var i in tree) {
        if (i == "links" || i == "nodes") {
            new_tree[i] = [];
            for (var j = 0; j < tree[i].length; j++) {
                new_tree[i][j] = {};
                for (var k in tree[i][j]) {
                    if (i == "links") {
                        new_tree[i][j][k] = {};
                        for (var l in tree[i][j][k])
                            new_tree[i][j][k][l] = copy_obj(tree[i][j][k][l]);
                    } else
                        new_tree[i][j][k] = copy_obj(tree[i][j][k]);
                }
            }
        } else
            new_tree[i] = copy_obj(tree[i]);
    }

    return new_tree;
}

/**
 * Compose unique shader identifier based on given name.
 */
function shader_ident(name_base) {
    if (!_shader_ident_counters[name_base])
        _shader_ident_counters[name_base] = 0;

    var name = name_base + "_" + _shader_ident_counters[name_base];
    // remove slash and space symbols
    name = name.replace(/ /g, "_").replace(/\//g, "_");

    _shader_ident_counters[name_base]++;

    return name;
}

function check_input_node_outputs(bpy_node) {
    var outputs = bpy_node["outputs"];
    for (var i = 0; i < outputs.length; i++) {
        var output = outputs[i];
        if (output["is_linked"])
            return true;
    }
    return false;
}

function geometry_node_type(bpy_node, output_num) {
    var outputs = bpy_node["outputs"];
    var out_counter = 0;
    for (var i = 0; i < outputs.length; i++) {
        var output = outputs[i];

        if (!output["is_linked"])
            continue;

        if ((out_counter++) < output_num)
            continue;

        switch (output["identifier"]) {
        case "UV":
            return "GEOMETRY_UV";
        case "Vertex Color":
            return "GEOMETRY_VC";
        case "Normal":
            return "GEOMETRY_NO";
        case "True Normal":
            return "GEOMETRY_TRN";
        case "Front/Back":
            return "GEOMETRY_FB";
        case "View":
            return "GEOMETRY_VW";
        case "Global":
        case "Position":
            return "GEOMETRY_GL";
        case "Local":
            return "GEOMETRY_LO";
        case "Orco":
            return "GEOMETRY_OR";
        case "Incoming":
            return "GEOMETRY_IN";
        case "Backfacing":
            return "GEOMETRY_BF";
        default:
            return null;
        }
    }
}

function tex_coord_node_type(bpy_node, output_num) {
    var outputs = bpy_node["outputs"];
    var out_counter = 0;
    for (var i = 0; i < outputs.length; i++) {
        var output = outputs[i];

        if (!output["is_linked"])
            continue;

        if ((out_counter++) < output_num)
            continue;

        switch (output["identifier"]) {
        case "Camera":
            return "TEX_COORD_CA";
        case "Generated":
            return "TEX_COORD_GE";
        case "Normal":
            return "TEX_COORD_NO";
        case "Object":
            return "TEX_COORD_OB";
        case "Reflection":
            return "TEX_COORD_RE";
        case "UV":
            return "TEX_COORD_UV";
        case "Window":
            return "TEX_COORD_WI";
        default:
            return null;
        }
    }
}

function node_output_check_next(bpy_node, output_num) {
    var outputs = bpy_node["outputs"];
    var out_counter = 0;
    for (var i = 0; i < outputs.length; i++) {
        var output = outputs[i];

        if (!output["is_linked"])
            continue;

        // next linked available
        if ((out_counter++) > output_num)
            return true;
    }

    return false;
}


function texture_node_type(bpy_node) {
    if (!bpy_node["texture"] || !bpy_node["texture"]._render)
        return "TEXTURE_EMPTY";

    var outputs = bpy_node["outputs"];
    var node_color  = false;
    var node_normal = false;
    var node_value  = false;
    for (var i = 0; i < outputs.length; i++) {
        var output = outputs[i];

        if (!output["is_linked"])
            continue;

        var ident = output["identifier"];

        switch (ident) {
        case "Color":
            node_color = true;
            break;
        case "Normal":
            node_normal = true;
            break;
        case "Value":
            node_value = true;
            break;
        default:
            m_util.panic("Unknown texture output");
        }
    }

    if (node_color) {
        if (node_normal)
            m_print.warn("Node \"" + bpy_node["name"] + "\" has both Color " +
                         "and Normal outputs. Normal will be omitted.");

        if (bpy_node["texture"]["type"] == "ENVIRONMENT_MAP")
            return "TEXTURE_ENVIRONMENT_CUBE";
        else
            return "TEXTURE_COLOR";

    } else if (node_normal) {
        return "TEXTURE_NORMAL"

    } else if (node_value) {
        if (bpy_node["texture"]["type"] == "ENVIRONMENT_MAP")
            return "TEXTURE_ENVIRONMENT_CUBE";
        else
            return "TEXTURE_COLOR";
    }
}

function node_input_by_ident(bpy_node, ident) {
    var inputs = bpy_node["inputs"];
    for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i];

        if (input["identifier"] == ident)
            return node_inout_bpy_to_b4w(input);
    }
    return null;
}

function node_output_by_ident(bpy_node, ident) {
    var outputs = bpy_node["outputs"];
    for (var i = 0; i < outputs.length; i++) {
        var output = outputs[i];

        if (output["identifier"] == ident)
            return node_inout_bpy_to_b4w(output);
    }
    return null;
}

function node_inout_bpy_to_b4w(bpy_node_inout) {
    return {
        name: bpy_node_inout["name"],
        identifier: bpy_node_inout["identifier"],
        is_linked: bpy_node_inout["is_linked"],
        default_value: bpy_to_b4w_value(bpy_node_inout["default_value"])
    }
}

function default_node_inout(name, identifier, default_value, is_linked) {
    return {
        name: name,
        identifier: identifier,
        is_linked: is_linked,
        default_value: default_value
    }
}

function clone_node_inout(node_inout) {
    return default_node_inout(node_inout.name, node_inout.identifier,
        node_inout.default_value, node_inout.is_linked);
}

function bpy_to_b4w_value(value) {

    if (m_util.is_vector(value))
        return value.slice(0);

    return value;
}

function node_inputs_bpy_to_b4w(bpy_node) {
    var inputs = [];

    for (var i = 0; i < bpy_node["inputs"].length; i++) {
        var input = node_inout_bpy_to_b4w(bpy_node["inputs"][i]);
        // NOTE: trim all vec4 to vec3
        if (input.default_value.length)
            input.default_value.splice(3);
        inputs.push(input);
    }

    return inputs;
}

function node_outputs_bpy_to_b4w(bpy_node) {
    var outputs = [];

    for (var i = 0; i < bpy_node["outputs"].length; i++) {
        var output = node_inout_bpy_to_b4w(bpy_node["outputs"][i]);
        outputs.push(output);
    }

    return outputs;
}


/**
 * value = null - do not assign param value
 */
function node_param(name, value, dim) {

    if (value === null || value === undefined)
        var pval = null;
    else
        var pval = m_shaders.glsl_value(value, dim);

    var param = {
        name: name,
        value: pval
    }

    return param;
}

function clone_node_param(param) {
    var new_param = {
        name: param.name,
        value: param.value
    };

    return new_param;
}

function replace_zero_unity_vals(str_val) {
    // HACK: for better global replacing
    str_val = str_val.replace(/(,)/g, "$1 ");

    str_val = str_val.replace(/(^|[^0-9]|\s)(0\.0)($|[^0-9]|\s)/g, "$1_0_0$3");
    str_val = str_val.replace(/(^|[^0-9]|\s)(1\.0)($|[^0-9]|\s)/g, "$1_1_0$3");
    str_val = str_val.replace(/\s+/g, "");

    return str_val;
}

function create_nmat_edge_attr() {
    // node1_output, node2_input
    var nmat_edge_attr = [0, 0];

    return nmat_edge_attr;
}

function clone_nmat_edge_attr(nmat_edge_attr) {
    return nmat_edge_attr.slice();
}

function append_nmat_edge(graph, id1, id2, attr1, attr2, bpy_link) {
    // pair [node1_output_index, node2_input_index]
    var attr = [];

    var ident1 = bpy_link["from_socket"]["identifier"];
    var ident2 = bpy_link["to_socket"]["identifier"];

    var outputs1 = attr1.outputs;
    for (var i = 0; i < outputs1.length; i++) {
        var out1 = outputs1[i];
        if (out1.identifier == ident1) {
            attr.push(i);
            break;
        }
    }

    var inputs2 = attr2.inputs;
    for (var i = 0; i < inputs2.length; i++) {
        var in2 = inputs2[i];
        if (in2.identifier == ident2) {
            attr.push(i);
            break;
        }
    }

    if (attr.length == 2)
        m_graph.append_edge(graph, id1, id2, attr);

    return true;
}

/**
 * Compose node elements for use in shader
 */
exports.compose_node_elements = function(graph) {

    var node_elements = [];

    var node_elem_map = {};

    reset_shader_ident_counters();

    var sgraph = m_graph.topsort(graph);
    m_graph.traverse(sgraph, function(id, attr) {
        var elem = init_node_elem(attr)
        node_elements.push(elem);
        node_elem_map[id] = elem;
    });

    m_graph.traverse_edges(sgraph, function(id1, id2, attr) {
        var node1 = m_graph.get_node_attr(sgraph, id1);
        var out1 = node1.outputs[attr[0]];

        var elem1_outputs = node_elem_map[id1].outputs;
        var elem2_inputs = node_elem_map[id2].inputs;
        // name after (unique) node output
        var name = elem1_outputs[attr[0]] ||
                shader_ident("out_" + node1.type + "_" 
                        + normalize_socket_ident(out1.identifier));

        elem1_outputs[attr[0]] = name;
        elem2_inputs[attr[1]] = name;
    });
    return node_elements;
}

function init_node_elem(mat_node) {

    var finputs = [];
    var finput_values = [];

    var foutputs = [];

    var fparams = [];
    var fparam_values = [];

    var vparams = [];

    for (var i = 0; i < mat_node.inputs.length; i++) {
        var input = mat_node.inputs[i];

        if (input.is_linked) {
            finputs.push(null);
            finput_values.push(null);
        } else {
            finputs.push(shader_ident("in_" + mat_node.type + "_" 
                    + normalize_socket_ident(input.identifier)));

            var input_val = m_shaders.glsl_value(input.default_value, 0);
            // HACK: too many vertex shader constants issue
            if (cfg_def.shader_constants_hack)
                if (mat_node.type.indexOf("MIX_RGB_") >= 0
                        && (input.identifier == "Color1"
                        || input.identifier == "Color2"
                        || input.identifier == "Fac") ||
                        mat_node.type.indexOf("MATH_") >= 0
                        && (input.identifier == "Value"
                        || input.identifier == "Value_001"
                        || input.identifier == "Value.001") ||
                        mat_node.type.indexOf("VECT_MATH_") >= 0
                        && (input.identifier == "Vector_001"
                        || input.identifier == "Vector.001") ||
                        mat_node.type.indexOf("LIGHTING_APPLY") >= 0 ||
                        mat_node.type.indexOf("MATERIAL_END") >= 0 ||
                        mat_node.type.indexOf("MATERIAL_BEGIN") >= 0)
                    input_val = replace_zero_unity_vals(input_val);

            finput_values.push(input_val);
        }
    }

    for (var i = 0; i < mat_node.outputs.length; i++) {
        var output = mat_node.outputs[i];

        if (output.is_linked)
            foutputs.push(null);
        else
            foutputs.push(shader_ident("out_" + mat_node.type + "_" 
                    + normalize_socket_ident(output.identifier)));
    }

    for (var i = 0; i < mat_node.params.length; i++) {
        var param = mat_node.params[i];
        fparams.push(param.name);
        fparam_values.push(param.value);
    }

    for (var i = 0; i < mat_node.vparams.length; i++) {
        var vparam = mat_node.vparams[i];
        vparams.push(vparam.name);
    }

    var elem = {
        id: mat_node.type,
        inputs: finputs,
        input_values: finput_values,
        outputs: foutputs,
        params: fparams,
        param_values: fparam_values,
        vparams: vparams,
        dirs: JSON.parse(JSON.stringify(mat_node.dirs)) // deep copy
    }

    return elem;
}

function normalize_socket_ident(node_identifier) {
    // NOTE: sometimes node sockets may have identifiers with the ".00N" postfix 
    // for an unknown reason, make it just "00N"
    return node_identifier.replace(/\./g, "");
}

function create_new_name(type, group_name, name) {
    if (type == "GROUP_INPUT")
        return group_name + "*GI*" + name;      // for search
    else if (type == "GROUP_OUTPUT")
        return group_name + "*GO*" + name;
    return group_name + "%join%" + name;
}

function rename_node_group_nodes(node_group_name, node_tree) {
    var nodes = node_tree["nodes"];
    var links = node_tree["links"];
    for (var i = 0; i < nodes.length; i++)
        nodes[i]["name"] = create_new_name(nodes[i].type, node_group_name, nodes[i].name);
    for (var i = 0; i < links.length; i++) {
        links[i]["from_node"]["name"] = create_new_name(links[i]["from_node"]["type"],
                                                node_group_name, links[i]["from_node"]["name"]);
        links[i]["to_node"]["name"] = create_new_name(links[i]["to_node"]["type"],
                                                node_group_name, links[i]["to_node"]["name"]);
    }
}

function trace_group_nodes(graph){
    var node_groups = [];
    m_graph.traverse(graph, function(id, node) {
        if (node["type"] == "GROUP")
            node_groups.push(node);
    });
    return node_groups;
}

function append_node_groups_graphs(graph, links, node_groups) {
    for (var i = 0; i < node_groups.length; i++) {
        var node_group_graph = node_groups[i].data.node_group_graph;
        var node_group_links = node_groups[i].data.node_group_links;
        if (!node_group_graph)
            return false;

        m_graph.traverse(node_group_graph, function(id, node) {
            m_graph.append_node(graph, m_graph.gen_node_id(graph), node);
        });

        for (var j = 0; j < node_group_links.length; j++)
            links.push(node_group_links[j]);

        change_node_groups_links(node_groups[i], links, graph);
    }
    return true;
}

function distribute_link(property, group_name, link, node_group_links,
                    node_group_input_links, node_group_output_links) {
    switch (property.type) {
    case "GROUP":
        if (property["name"] == group_name)
            node_group_links.push(link);
        break;
    case "GROUP_INPUT":
        if (!property["name"].indexOf(group_name + "*GI*"))
            node_group_input_links.push(link);
        break;
    case "GROUP_OUTPUT":
        if (!property["name"].indexOf(group_name + "*GO*"))
            node_group_output_links.push(link);
        break;
    }
}

// change links, return links for cut
function relink(links, input_links, output_links) {
    var unused_links = [];
    for (var i = 0; i < output_links.length; i++) {
        var output = output_links[i];
        var input = null;
        for (var j = 0; j < input_links.length; j++)
            if (output["from_socket"]["identifier"] ==
                input_links[j]["to_socket"]["identifier"]) {
                input = input_links[j]
                break;
            }
        if (input) {
            output["from_node"] = input["from_node"];
            output["from_socket"] = input["from_socket"];
        } else
            unused_links.push(output);
    }
    // remove links to node group or to group_output
    for (var i = 0; i < input_links.length; i++)
        links.splice(links.indexOf(input_links[i]), 1);
    return unused_links;
}

function add_unused_input_links(links, unused_links) {
    if (!unused_links.length)
        return;
    var gi_name = unused_links[0]["from_node"]["name"];
    for (var i = 0; i < links.length; i++)
        if (links[i]["from_node"]["name"] == gi_name)
            unused_links.push(links[i]);
}

function set_input_default_value(link, graph, value) {
    var node_ids = nmat_node_ids(link["to_node"], graph);
    for (var i = 0; i < node_ids.length; i++) {
        var node_attr = m_graph.get_node_attr(graph, node_ids[i]);
        for (var j = 0; j < node_attr.inputs.length; j++) {
            var input = node_attr.inputs[j];
            if (input.identifier == link["to_socket"]["identifier"]) {

                var old_val_type = get_socket_value_type(input.default_value);
                var new_val_type = get_socket_value_type(value);

                if (new_val_type == old_val_type)
                    input.default_value = value;
                else
                    switch (old_val_type) {
                    case VECTOR_VALUE:
                        scalar_to_vector(value, input.default_value);
                        break;
                    case SCALAR_VALUE:
                        input.default_value = vector_to_scalar(value);
                        break;
                    }

                break;
            }
        }
    }
}

function change_default_values(links, graph, node, unused_links) {
    for (var i = 0; i < unused_links.length; i++) {
        var link = unused_links[i];
        var value;
        for (var j = 0; j < node.inputs.length; j++)
            if (link["from_socket"]["identifier"] == node.inputs[j].identifier) {
                value = node.inputs[j].default_value;
                break;
            }
        set_input_default_value(link, graph, value);
        var index = links.indexOf(link);
        if (index != -1)
            links.splice(index, 1);
    }
}

// get type for a node input/output.
function get_socket_value_type(value) {
    return value instanceof Object ? VECTOR_VALUE : SCALAR_VALUE;
}

// convert scalar socket value to vector
function scalar_to_vector(scalar, vector) {
    vector[0] = vector[1] = vector[2] = scalar;
    return vector;
}

// convert vector socket value to scalar
function vector_to_scalar(vector) {
    return (vector[0] + vector[1] + vector[2]) / 3.0;
}

function change_node_groups_links(node, links, graph) {
    var group_name = node.name;

    var node_group_links_from = [];     // node outputs
    var node_group_links_to = [];       // node inputs
    var node_group_input_links = [];
    var node_group_output_links = [];

    // find links to/from node_group, group_input, group_output
    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        distribute_link(link["from_node"], group_name, link, node_group_links_from,
            node_group_input_links, node_group_output_links);
        distribute_link(link["to_node"], group_name, link, node_group_links_to,
            node_group_input_links, node_group_output_links);
    }
    // remove links to node_group; connect group_input links to nodes of removed links
    var unused_input_links = relink(links, node_group_links_to, node_group_input_links);
    // remove links to group_output; connect links from node_group to nodes of removed links
    var unused_output_links = relink(links, node_group_output_links, node_group_links_from);
    // if last relink makes new links with group input
    add_unused_input_links(links, unused_input_links);

    // change default value of group nodes connected to group_input
    change_default_values(links, graph, node, unused_input_links);
    // change default value of node with links from node_group
    if (unused_output_links.length) {
        var output_node;
        m_graph.traverse(graph, function(id, node) {
            if (node.type == "GROUP_OUTPUT" &&
                !node.name.indexOf(group_name + "*GO*"))
                output_node = node;
        });
        change_default_values(links, graph, output_node, unused_output_links);
    }
}

exports.check_material_glow_output = function(mat) {
    if (mat["node_tree"])
        for (var i = 0; i < mat["node_tree"]["nodes"].length; i++) {
            var node = mat["node_tree"]["nodes"][i]
            if (node.type == "GROUP" && node["node_tree_name"] == "B4W_GLOW_OUTPUT")
                return true;
        }
    return false;
}

exports.print_node_graph = print_node_graph;
function print_node_graph(node_graph, mat_name) {
    m_print.log("\n================ MATERIAL: " + mat_name + " ================"
            + "\n" + m_debug.nodegraph_to_dot(node_graph, true)
            + "\n============================================================");
}

exports.cleanup = cleanup;
function cleanup() {
    for (var graph_id in _composed_ngraph_proxies) {
        delete _composed_ngraph_proxies[graph_id];
    }
    for (var graph_id in _composed_stack_graphs) {
        delete _composed_stack_graphs[graph_id];
    }

    for (var key in _lamp_indexes)
        delete _lamp_indexes[key];
    _lamp_index = 0;
}

function create_node_textures(nmat_graph) {
    var color_ramp_nodes = [];
    var curves_nodes = [];
    m_graph.traverse(nmat_graph, function(node, attr) {
        switch (attr.type) {
        case "VALTORGB":
            color_ramp_nodes.push(attr);
            break;
        case "CURVE_VEC":
        case "CURVE_RGB":
            curves_nodes.push(attr);
            break;
        }
    });
    var row = 0;
    var col_ramp_data = null;
    var curve_data = null;
    var length = color_ramp_nodes.length + curves_nodes.length;
    if (color_ramp_nodes.length) {
        col_ramp_data = m_tex.extract_col_ramps_data(color_ramp_nodes,
                m_tex.COLORRAMP_TEXT_SIZE);
        for (var i = 0; i < color_ramp_nodes.length; i++) {
            color_ramp_nodes[i].dirs.push(["NODE_TEX_ROW", m_shaders.glsl_value((row + 0.5) /
                    length)]);
            row++;
        }
    }
    if (curves_nodes.length) {
        curve_data = m_tex.extract_vec_curves_data(curves_nodes,
                m_tex.CURVE_NODES_TEXT_SIZE);
        for (var i = 0; i < curves_nodes.length; i++) {
            curves_nodes[i].dirs.push(["NODE_TEX_ROW", m_shaders.glsl_value((row + 0.5) /
                    length)]);
            row++;
        }
    }
    var image_data = null;
    if (col_ramp_data && curve_data) {
        image_data = new Uint8Array(col_ramp_data.length + curve_data.length);
        image_data.set(col_ramp_data);
        image_data.set(curve_data, col_ramp_data.length);
    } else if (col_ramp_data)
        image_data = col_ramp_data;
    else
        image_data = curve_data;

    if (image_data)
        var tex = m_tex.create_color_ramp_texture(image_data, m_tex.CURVE_NODES_TEXT_SIZE);
    else
        var tex = null;

    for (var i = 0; i < color_ramp_nodes.length; i++)
        color_ramp_nodes[i].data.texture = tex;
    for (var i = 0; i < curves_nodes.length; i++)
        curves_nodes[i].data.texture = tex;
}

exports.get_max_env_texture_height = get_max_env_texture_height;
function get_max_env_texture_height(graph) {
    var max_height = -1;
    m_graph.traverse(graph, function(id, node) {
        if (node.type == "TEXTURE_ENVIRONMENT_EQUIRECTANGULAR" || node.type == "TEXTURE_ENVIRONMENT_MIRROR_BALL") {
            var tex_height = node.data.value.height;
            max_height = Math.max(max_height, tex_height);
        }
    });

    return  max_height;
}

function check_curve_usage(bpy_node, ind, start, end) {
    var curve = bpy_node["curve_mapping"]["curves_data"][ind];
    if (curve.length == 2 && curve[0][0] < start + CURVE_POINT_EPS
            && curve[0][1] < start + CURVE_POINT_EPS 
            && curve[1][0] > end - CURVE_POINT_EPS
            && curve[1][1] > end - CURVE_POINT_EPS)
        return false;
    return true;
}

}
